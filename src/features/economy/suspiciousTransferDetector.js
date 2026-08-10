require("colors");

const { coinSystem } = require("../../config");
const { raiseSuspicion } = require("./suspiciousAlert");

// 偵測過去 N 小時內 A↔B 雙向轉帳，回傳超過閾值的配對。
// 用於：
// 1) transfer.js 即時告警（singlePair 模式：給定 A、B，只算這一組）
// 2) 每日播報（scanAll 模式：掃所有近期 transfer_out，列出全部可疑配對）
//
// 重要：MongoDB Aggregation 沒有 abs sum 直接套用，這裡用 |amount| 還原為「轉了多少」。
// transfer_out 的 amount 為負（含手續費），meta.amount 才是實際轉出金額；統一以 meta.amount 為準。

const TRANSFER_OUT = "transfer_out";
const EVENT_PRIZE = "event_prize";

// 只採計「錢真的到對方手上」的紀錄：
// - meta.held：託管中，收款人還沒按收下，金流尚未成立
// - meta.refunded：已退回（拒收 / 逾時 / 取消），金流從未成立
// 少了這層過濾，收款人一拒收就會被判定為對敲而扣信用分。
const SETTLED_ONLY = {
  "meta.held": { $ne: true },
  "meta.refunded": { $ne: true },
};

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
      ...SETTLED_ONLY,
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

  // 對敲＝雙向各自都達到閾值才算（單向大額、另一向零星不算洗幣）
  if (aToB < min || bToA < min) return null;
  const total = aToB + bToA;

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

  const filter = { source: TRANSFER_OUT, createdAt: { $gte: since }, ...SETTLED_ONLY };
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
    // 對敲＝雙向各自都達到閾值才算
    if (p.aToB < min || p.bToA < min) continue;
    const total = p.aToB + p.bToA;
    out.push({ ...p, total, threshold: min, hours: lookback });
  }
  // 由總額大到小
  out.sort((x, y) => y.total - x.total);
  return out;
}

// ── 圈狀轉帳偵測（A→B→C→A，資金繞一圈回到起點）─────────────────────────────
const getRingMinEdge = () => coinSystem?.transfer?.ringMinEdge ?? getThreshold();
const getRingMaxLen = () => coinSystem?.transfer?.ringMaxLen ?? 4;

// 從一筆金流紀錄還原有向邊的 from/to：
// - transfer_out：userId → meta.counterparty
// - event_prize：meta.hostId（出資主辦人）→ userId（得獎者）
function edgeEndpointsOf(d) {
  if (d.source === EVENT_PRIZE) return { from: d?.meta?.hostId, to: d.userId };
  return { from: d.userId, to: d?.meta?.counterparty };
}

// 建有向邊：from → Map(to → 期間內累積轉出金額)。自轉、0 額不計。
// 含玩家轉帳與活動獎金發放，讓活動獎金無法當作偵測盲區的側通道。
async function buildDirectedEdges(client, { guildId, hours } = {}) {
  if (!client?.coinTransactionsCollection) return new Map();
  const since = lookbackDate(hours ?? getLookbackHours());
  const filter = {
    source: { $in: [TRANSFER_OUT, EVENT_PRIZE] },
    createdAt: { $gte: since },
    ...SETTLED_ONLY,
  };
  if (guildId) filter.guildId = guildId;
  const docs = await client.coinTransactionsCollection.find(filter).toArray();
  const edges = new Map();
  for (const d of docs) {
    const { from, to } = edgeEndpointsOf(d);
    if (!from || !to || from === to) continue;
    const amt = transferAmountOf(d);
    if (amt <= 0) continue;
    if (!edges.has(from)) edges.set(from, new Map());
    const m = edges.get(from);
    m.set(to, (m.get(to) || 0) + amt);
  }
  return edges;
}

// 從有向邊圖取 a、b 之間的雙向累積金額。
function pairTotalFromEdges(edges, a, b) {
  const aToB = edges.get(a)?.get(b) || 0;
  const bToA = edges.get(b)?.get(a) || 0;
  return { aToB, bToA, total: aToB + bToA };
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

      const minutesAgo = (date) =>
        Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));

      if (pair) {
        await raiseSuspicion(client, {
          guildId,
          kind: "pair",
          users: [senderId, recipientId],
          description:
            `<@${senderId}> → <@${recipientId}>：${pair.aToB.toLocaleString()} credits（最近 ${minutesAgo(pair.lastAtoBAt)} 分鐘前）\n` +
            `<@${recipientId}> → <@${senderId}>：${pair.bToA.toLocaleString()} credits（最近 ${minutesAgo(pair.lastBtoAAt)} 分鐘前）`,
          fields: [
            {
              name: `${pair.hours}h 雙向總額`,
              value: `**${pair.total.toLocaleString()}** credits（閾值 ${pair.threshold.toLocaleString()}）`,
            },
          ],
        });
      }

      if (ring) {
        const chain = `${ring.cycle.map((u) => `<@${u}>`).join(" → ")} → <@${ring.cycle[0]}>`;
        await raiseSuspicion(client, {
          guildId,
          kind: "ring",
          users: ring.cycle,
          description: `資金繞一圈回到起點：\n${chain}`,
          fields: [
            {
              name: "環內最小單邊",
              value: `**${ring.minEdge.toLocaleString()}** credits（${ring.cycle.length} 人參與）`,
            },
          ],
        });
      }
    })
    .catch((e) => {
      console.log(`[SUSP-XFER] 偵測失敗: ${e?.message || e}`.red);
    });
}

// 活動結算後呼叫：把主辦人與各得獎者的金流（含活動獎金）走一次 pair/ring 偵測。
// 非阻塞、錯誤吞掉只寫 console，與 fireImmediateCheck 同一套告警邏輯。
function fireEventPayoutCheck(client, { guildId, hostId, winnerIds }) {
  Promise.resolve()
    .then(async () => {
      if (!coinSystem?.transfer) return;
      const edges = await buildDirectedEdges(client, { guildId });
      const threshold = getThreshold();

      const flagged = new Set();
      for (const winnerId of winnerIds || []) {
        if (!winnerId || winnerId === hostId || flagged.has(winnerId)) continue;
        const { aToB, bToA, total } = pairTotalFromEdges(edges, hostId, winnerId);
        if (aToB >= threshold && bToA >= threshold) {
          flagged.add(winnerId);
          await raiseSuspicion(client, {
            guildId,
            kind: "pair",
            users: [hostId, winnerId],
            description:
              `<@${hostId}> → <@${winnerId}>：${aToB.toLocaleString()} credits（含活動獎金）\n` +
              `<@${winnerId}> → <@${hostId}>：${bToA.toLocaleString()} credits`,
            fields: [
              {
                name: `${getLookbackHours()}h 雙向總額`,
                value: `**${total.toLocaleString()}** credits（閾值 ${threshold.toLocaleString()}）`,
              },
            ],
          });
        }
      }

      const ring = detectRingFrom(edges, hostId, {
        maxLen: getRingMaxLen(),
        minEdge: getRingMinEdge(),
      });
      if (ring) {
        const chain = `${ring.cycle.map((u) => `<@${u}>`).join(" → ")} → <@${ring.cycle[0]}>`;
        await raiseSuspicion(client, {
          guildId,
          kind: "ring",
          users: ring.cycle,
          description: `資金繞一圈回到起點（含活動獎金）：\n${chain}`,
          fields: [
            {
              name: "環內最小單邊",
              value: `**${ring.minEdge.toLocaleString()}** credits（${ring.cycle.length} 人參與）`,
            },
          ],
        });
      }
    })
    .catch((e) => {
      console.log(`[SUSP-XFER] 活動偵測失敗: ${e?.message || e}`.red);
    });
}

module.exports = {
  detectPair,
  scanAllPairs,
  scanRings,
  buildDirectedEdges,
  pairTotalFromEdges,
  detectRingFrom,
  fireImmediateCheck,
  fireEventPayoutCheck,
  transferAmountOf,
};
