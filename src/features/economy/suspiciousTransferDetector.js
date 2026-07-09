require("colors");

const { coinSystem, bank } = require("../../config");
const creditService = require("../bank/creditService");

// 偵測過去 N 小時內 A↔B 雙向轉帳，回傳超過閾值的配對。
// 用於：
// 1) transfer.js 即時告警（singlePair 模式：給定 A、B，只算這一組）
// 2) 每日播報（scanAll 模式：掃所有近期 transfer_out，列出全部可疑配對）
//
// 重要：MongoDB Aggregation 沒有 abs sum 直接套用，這裡用 |amount| 還原為「轉了多少」。
// transfer_out 的 amount 為負（含手續費），meta.amount 才是實際轉出金額；統一以 meta.amount 為準。

const TRANSFER_OUT = "transfer_out";

const getThreshold = () =>
  coinSystem?.transfer?.suspiciousThreshold ?? 5000;

const getLookbackHours = () =>
  coinSystem?.dailyEconomyReport?.suspiciousLookbackHours ?? 24;

// 回傳 Date 物件對應 N 小時前
const lookbackDate = (hours) =>
  new Date(Date.now() - hours * 60 * 60 * 1000);

// 取單筆 transfer_out 的「實際轉出金額」（不含手續費）
const transferAmountOf = (doc) => {
  const metaAmt = Number(doc?.meta?.amount);
  if (Number.isFinite(metaAmt) && metaAmt > 0) return metaAmt;
  // 後備：用 |amount| - fee
  const fee = Number(doc?.meta?.fee || 0);
  return Math.max(0, Math.abs(Number(doc?.amount || 0)) - fee);
};

// 偵測 A 與 B 之間在 lookback 內的雙向轉帳；若雙向總額 > 閾值，回傳細節。
async function detectPair(client, { guildId, userA, userB, hours, threshold } = {}) {
  if (!client?.coinTransactionsCollection) return null;
  const lookback = hours ?? getLookbackHours();
  const min = threshold ?? getThreshold();
  const since = lookbackDate(lookback);

  const docs = await client.coinTransactionsCollection
    .find({
      guildId,
      source: TRANSFER_OUT,
      createdAt: { $gte: since },
      $or: [
        { userId: userA, "meta.counterparty": userB },
        { userId: userB, "meta.counterparty": userA },
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();

  if (docs.length === 0) return null;

  let aToB = 0;
  let bToA = 0;
  let firstAtoBAt = null;
  let lastBtoAAt = null;
  let firstBtoAAt = null;
  let lastAtoBAt = null;
  for (const d of docs) {
    const amt = transferAmountOf(d);
    if (d.userId === userA) {
      aToB += amt;
      if (!firstAtoBAt) firstAtoBAt = d.createdAt;
      lastAtoBAt = d.createdAt;
    } else {
      bToA += amt;
      if (!firstBtoAAt) firstBtoAAt = d.createdAt;
      lastBtoAAt = d.createdAt;
    }
  }

  if (aToB <= 0 || bToA <= 0) return null; // 必須雙向都有
  const total = aToB + bToA;
  if (total < min) return null;

  return {
    userA,
    userB,
    aToB,
    bToA,
    total,
    threshold: min,
    hours: lookback,
    firstAtoBAt,
    lastAtoBAt,
    firstBtoAAt,
    lastBtoAAt,
    docCount: docs.length,
  };
}

// 掃描全部 lookback 內 transfer_out，列出所有雙向總額 > 閾值的配對
async function scanAllPairs(client, { guildId, hours, threshold } = {}) {
  if (!client?.coinTransactionsCollection) return [];
  const lookback = hours ?? getLookbackHours();
  const min = threshold ?? getThreshold();
  const since = lookbackDate(lookback);

  const filter = { source: TRANSFER_OUT, createdAt: { $gte: since } };
  if (guildId) filter.guildId = guildId;

  const docs = await client.coinTransactionsCollection
    .find(filter)
    .sort({ createdAt: 1 })
    .toArray();

  // 以 sorted pair 為 key 累積
  const pairs = new Map();
  for (const d of docs) {
    const from = d.userId;
    const to = d?.meta?.counterparty;
    if (!from || !to) continue;
    const [a, b] = [from, to].sort();
    const key = `${d.guildId || ""}|${a}|${b}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        guildId: d.guildId,
        userA: a,
        userB: b,
        aToB: 0,
        bToA: 0,
        firstAt: d.createdAt,
        lastAt: d.createdAt,
        docCount: 0,
      });
    }
    const p = pairs.get(key);
    const amt = transferAmountOf(d);
    if (from === a) p.aToB += amt;
    else p.bToA += amt;
    if (d.createdAt < p.firstAt) p.firstAt = d.createdAt;
    if (d.createdAt > p.lastAt) p.lastAt = d.createdAt;
    p.docCount += 1;
  }

  const out = [];
  for (const p of pairs.values()) {
    if (p.aToB <= 0 || p.bToA <= 0) continue;
    const total = p.aToB + p.bToA;
    if (total < min) continue;
    out.push({ ...p, total, threshold: min, hours: lookback });
  }
  // 由總額大到小
  out.sort((x, y) => y.total - x.total);
  return out;
}

// ── 圈狀轉帳偵測（A→B→C→A，資金繞一圈回到起點）─────────────────────────────
const getRingMinEdge = () => coinSystem?.transfer?.ringMinEdge ?? getThreshold();
const getRingMaxLen = () => coinSystem?.transfer?.ringMaxLen ?? 4;

// 建有向邊：from → Map(to → 期間內累積轉出金額)。自轉、0 額不計。
async function buildDirectedEdges(client, { guildId, hours } = {}) {
  if (!client?.coinTransactionsCollection) return new Map();
  const since = lookbackDate(hours ?? getLookbackHours());
  const filter = { source: TRANSFER_OUT, createdAt: { $gte: since } };
  if (guildId) filter.guildId = guildId;
  const docs = await client.coinTransactionsCollection.find(filter).toArray();
  const edges = new Map();
  for (const d of docs) {
    const from = d.userId;
    const to = d?.meta?.counterparty;
    if (!from || !to || from === to) continue;
    const amt = transferAmountOf(d);
    if (amt <= 0) continue;
    if (!edges.has(from)) edges.set(from, new Map());
    const m = edges.get(from);
    m.set(to, (m.get(to) || 0) + amt);
  }
  return edges;
}

// 從 start 找一條長度 3~maxLen、每段 ≥ minEdge、且回到 start 的環（DFS，找到即回傳）。
function detectRingFrom(edges, start, { maxLen = 4, minEdge = 0 } = {}) {
  const path = [start];
  const visited = new Set([start]);
  let found = null;
  function dfs(node, minAmt) {
    if (found || path.length > maxLen) return;
    const outs = edges.get(node);
    if (!outs) return;
    for (const [to, amt] of outs) {
      if (amt < minEdge) continue;
      if (to === start) {
        if (path.length >= 3) found = { cycle: [...path], minEdge: Math.min(minAmt, amt) };
        continue;
      }
      if (visited.has(to)) continue;
      visited.add(to);
      path.push(to);
      dfs(to, Math.min(minAmt, amt));
      path.pop();
      visited.delete(to);
      if (found) return;
    }
  }
  dfs(start, Infinity);
  return found;
}

// 掃全服環（每日報表用），依成員集合去重、環內最小單邊由大到小排序。
async function scanRings(client, { guildId, hours, minEdge, maxLen } = {}) {
  const edges = await buildDirectedEdges(client, { guildId, hours });
  const min = minEdge ?? getRingMinEdge();
  const len = maxLen ?? getRingMaxLen();
  const seen = new Set();
  const rings = [];
  for (const start of edges.keys()) {
    const r = detectRingFrom(edges, start, { maxLen: len, minEdge: min });
    if (!r) continue;
    const key = [...r.cycle].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rings.push(r);
  }
  rings.sort((a, b) => b.minEdge - a.minEdge);
  return rings;
}

async function getAlertChannel(client) {
  const channelId =
    coinSystem?.adminGrant?.auditLogChannelId || coinSystem?.dailyEconomyReport?.channelId;
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() ? channel : null;
}

async function penalizeUsers(client, guildId, userIds) {
  if (!bank?.credit?.enabled) return;
  for (const uid of userIds) {
    await creditService.flagSuspicious(client, uid, guildId).catch(() => {});
  }
}

// transfer.js 完成轉帳後呼叫；非阻塞、錯誤吞掉只寫 console。同時查雙向對敲與圈狀轉帳。
function fireImmediateCheck(client, { guildId, senderId, recipientId }) {
  Promise.resolve()
    .then(async () => {
      const cfg = coinSystem?.transfer;
      if (!cfg) return;

      const pair = await detectPair(client, { guildId, userA: senderId, userB: recipientId });
      const edges = await buildDirectedEdges(client, { guildId });
      const ring = detectRingFrom(edges, senderId, {
        maxLen: getRingMaxLen(),
        minEdge: getRingMinEdge(),
      });
      if (!pair && !ring) return;

      const channel = await getAlertChannel(client);
      const minutesAgo = (date) =>
        Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));

      if (pair) {
        await penalizeUsers(client, guildId, [senderId, recipientId]);
        if (channel) {
          await channel
            .send({
              content: [
                "⚠️ 可疑雙向轉帳",
                `<@${senderId}> → <@${recipientId}>：${pair.aToB.toLocaleString()} credits（最近 ${minutesAgo(pair.lastAtoBAt)} 分鐘前）`,
                `<@${recipientId}> → <@${senderId}>：${pair.bToA.toLocaleString()} credits（最近 ${minutesAgo(pair.lastBtoAAt)} 分鐘前）`,
                `${pair.hours}h 雙向總額：**${pair.total.toLocaleString()}** credits（閾值 ${pair.threshold.toLocaleString()}）`,
              ].join("\n"),
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        }
      }

      if (ring) {
        await penalizeUsers(client, guildId, ring.cycle);
        if (channel) {
          const chain = `${ring.cycle.map((u) => `<@${u}>`).join(" → ")} → <@${ring.cycle[0]}>`;
          await channel
            .send({
              content: [
                "⚠️ 可疑圈狀轉帳（資金繞一圈回到起點）",
                chain,
                `環內最小單邊：**${ring.minEdge.toLocaleString()}** credits（${ring.cycle.length} 人參與）`,
              ].join("\n"),
              allowedMentions: { parse: [] },
            })
            .catch(() => {});
        }
      }
    })
    .catch((e) => {
      console.log(`[SUSP-XFER] 偵測失敗: ${e?.message || e}`.red);
    });
}

module.exports = {
  detectPair,
  scanAllPairs,
  scanRings,
  buildDirectedEdges,
  detectRingFrom,
  fireImmediateCheck,
  transferAmountOf,
};
