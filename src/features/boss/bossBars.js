// 分段血條：魔王的血量切成 N 條，每打爆一條就是一個里程碑——
// 即時分獎勵池、點名破條手、全場短暫爆發、每兩條吹一次反攻號角。
// 魔王逃走時已打爆的血條獎勵早就入帳，結算再依「打爆幾條」按比例發排名獎，不再全有全無。
//
// 存來源不存結果：doc 只存 bars_total（出場時決定）、bars_broken（原子搶公告用）、
// bar_damage.<條>.<userId>（每條血各自的傷害），階段 / 反擊加成 / 號角次數一律讀取端換算。
// 本模組不碰 Discord，也不 require bossEngine（engine 會 require 這裡）。
require("colors");
const { boss } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const bossSkills = require("./bossSkills");

function bcfg() {
  return boss?.bars || {};
}

function fmt(tpl, vars) {
  if (!tpl) return null;
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  return out;
}

function countFor(spawnSource) {
  const c = bcfg();
  if (!c.enabled) return 1;
  return Math.max(1, c.countBySource?.[spawnSource || "manual"] ?? c.defaultCount ?? 1);
}

// 舊場次（改版前出場、沒有 bars_total）一律視為單條血，行為與以前一樣。
function totalOf(bossDoc) {
  return Math.max(1, bossDoc?.bars_total || 1);
}

function enabledFor(bossDoc) {
  return totalOf(bossDoc) > 1;
}

function barHp(bossDoc) {
  return (bossDoc?.max_hp || 0) / totalOf(bossDoc);
}

// 依目前血量換算打爆了幾條。回血被夾在已打爆的條數之上，所以這個值只會往上走。
function brokenFromHp(bossDoc, hp = bossDoc?.current_hp) {
  const total = totalOf(bossDoc);
  const per = barHp(bossDoc);
  if (per <= 0) return 0;
  const lost = (bossDoc.max_hp || 0) - Math.max(0, hp ?? 0);
  return Math.max(0, Math.min(total, Math.floor(lost / per + 1e-9)));
}

// 正在打的那一條（0 起算）與它剩下的血量。
function currentBar(bossDoc) {
  const total = totalOf(bossDoc);
  const broken = brokenFromHp(bossDoc);
  const index = Math.min(total - 1, broken);
  const per = barHp(bossDoc);
  const floor = (bossDoc.max_hp || 0) - (index + 1) * per;
  const remain = Math.max(0, (bossDoc.current_hp ?? 0) - floor);
  return { index, total, broken, per, remain, ratio: per > 0 ? remain / per : 0 };
}

// 這一刀打在第幾條（用出手前的血量判定；跨條的那一刀整刀算在原本那條）。
function barIndexForHit(bossDoc) {
  return currentBar(bossDoc).index;
}

// 回血上限：不能補回已經打爆的血條（血條是保底進度）。
function healCap(bossDoc) {
  return (bossDoc.max_hp || 0) - (bossDoc.bars_broken || 0) * barHp(bossDoc);
}

// 「打爆比例」：給階段判定與結算比例共用。
function clearRatio(bossDoc) {
  return brokenFromHp(bossDoc) / totalOf(bossDoc);
}

function counterBonus(bossDoc) {
  if (!enabledFor(bossDoc)) return 0;
  return brokenFromHp(bossDoc) * (bcfg().counterPerBar || 0);
}

// ── 反攻號角：每打爆 everyBars 條吹一次，所有人出刀上限 +attackBonus ─────────
function rallyCfg() {
  return boss?.rally || {};
}

function rallyEnabled(bossDoc) {
  const cfg = rallyCfg();
  if (!cfg.enabled || !enabledFor(bossDoc)) return false;
  const sources = Array.isArray(cfg.spawnSources) ? cfg.spawnSources : ["summon"];
  return sources.includes(bossDoc?.spawn_source || "scheduled");
}

function rallyCountAt(bossDoc, broken) {
  if (!rallyEnabled(bossDoc)) return 0;
  const every = rallyCfg().everyBars || 0;
  if (every <= 0) return 0;
  return Math.min(rallyCfg().maxRallies ?? 0, Math.floor(broken / every));
}

function rallyCount(bossDoc) {
  return rallyCountAt(bossDoc, bossDoc?.bars_broken || 0);
}

function rallyBonus(bossDoc) {
  return rallyCount(bossDoc) * (rallyCfg().attackBonus ?? 0);
}

// ── 打爆血條的獎勵 ─────────────────────────────────────────
function poolPerBar(bossDoc) {
  return Math.floor((bossDoc.max_hp || 0) * (boss?.rewards?.poolRatio ?? 0.5) / totalOf(bossDoc));
}

// 依該條血的傷害占比切獎勵池。純計算，不寫庫——方便戰況面板預估「這條打爆你會分到多少」。
function splitBar(bossDoc, index) {
  const dmg = (bossDoc.bar_damage || {})[index] || {};
  const total = Object.values(dmg).reduce((s, v) => s + (v || 0), 0);
  const pool = poolPerBar(bossDoc);
  const rows = Object.entries(dmg)
    .filter(([, v]) => v > 0)
    .map(([userId, damage]) => ({
      userId,
      damage,
      share: total > 0 ? damage / total : 0,
      coins: total > 0 ? Math.floor(pool * damage / total) : 0,
    }))
    .sort((a, b) => b.damage - a.damage);
  return { rows, total, pool };
}

async function grantRare(client, { userId, guildId, qty }) {
  if (!client.miningProfilesCollection || qty <= 0) return;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { legendary_fragments: qty }, $set: { updatedAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
}

async function usernamesOf(client, bossId, userIds) {
  const map = new Map();
  if (!client.bossDamageLogsCollection || !userIds.length) return map;
  const logs = await client.bossDamageLogsCollection
    .find({ boss_id: bossId, user_id: { $in: userIds } }, { projection: { user_id: 1, username: 1 } })
    .toArray()
    .catch(() => []);
  for (const l of logs) if (l.username) map.set(l.user_id, l.username);
  return map;
}

async function payBar(client, bossDoc, index, breakerUserId) {
  const c = bcfg();
  const { rows, pool } = splitBar(bossDoc, index);
  const guildId = bossDoc.guild_id;
  const names = await usernamesOf(client, bossDoc.boss_id, rows.map((r) => r.userId));
  const inc = {};
  const rareWinners = [];

  for (const r of rows) {
    let coins = r.coins;
    if (r.userId === breakerUserId) coins += c.breakerBonus || 0;
    if (coins > 0) {
      await grantCoins(client, {
        userId: r.userId,
        guildId,
        username: names.get(r.userId),
        amount: coins,
        source: "boss_loot",
      }).catch((e) => console.log(`[BOSS] bar reward fail ${r.userId}: ${e.message}`.red));
      inc[`bar_coins_by_user.${r.userId}`] = coins;
    }
    if (r.share >= (c.rareMinShare ?? 0) && Math.random() < (c.rareChance || 0)) {
      await grantRare(client, { userId: r.userId, guildId, qty: 1 });
      inc[`bar_rare_by_user.${r.userId}`] = 1;
      rareWinners.push(r.userId);
    }
  }
  // 破條手如果整條都沒出手（例如用道具打出最後一下），破條獎還是要給。
  if (breakerUserId && !rows.some((r) => r.userId === breakerUserId) && (c.breakerBonus || 0) > 0) {
    await grantCoins(client, {
      userId: breakerUserId,
      guildId,
      amount: c.breakerBonus,
      source: "boss_loot",
    }).catch(() => {});
    inc[`bar_coins_by_user.${breakerUserId}`] = c.breakerBonus;
  }
  if (Object.keys(inc).length) {
    await client.bossEventsCollection.updateOne({ boss_id: bossDoc.boss_id }, { $inc: inc }).catch(() => {});
  }
  return { rows, pool, rareWinners };
}

function barEvent(bossDoc, index, payout, breakerUserId, isLast) {
  const c = bcfg();
  const total = totalOf(bossDoc);
  const user = breakerUserId ? `<@${breakerUserId}>` : "全場";
  const lines = [
    fmt(c.announcement, { user, name: bossDoc.name, bar: index + 1, total }),
  ];
  if (payout.rows.length) {
    lines.push(fmt(c.rewardLine, {
      count: payout.rows.length,
      coins: payout.pool.toLocaleString(),
      user,
      bonus: (c.breakerBonus || 0).toLocaleString(),
    }));
  }
  if (payout.rareWinners.length) {
    lines.push(fmt(c.rareLine, { users: payout.rareWinners.map((u) => `<@${u}>`).join("、") }));
  }
  if (!isLast && c.burstLine) lines.push(c.burstLine);
  return {
    type: "bar_break",
    bar: index + 1,
    total,
    breakerUserId: breakerUserId || null,
    text: lines.filter(Boolean).join("\n"),
    hint: index + 2 === total ? c.lastBarLine || null : null,
  };
}

function rallyEvent(bossDoc, round, broken) {
  const cfg = rallyCfg();
  return {
    type: "rally",
    round,
    bonus: cfg.attackBonus ?? 0,
    text: fmt(cfg.announcement, { name: bossDoc.name, bars: broken, round, bonus: cfg.attackBonus ?? 0 }),
    hint: cfg.hint || null,
  };
}

// 每次扣血後呼叫。原子把 bars_broken 從舊值換成新值，只有換成功的那一刀負責發獎與公告，
// 同時出手的人不會重複發。換失敗代表別人剛好搶先，重讀一次再試（他可能只打爆了較少條）。
async function processBreaks(client, afterDoc, { breakerUserId = null, now = Date.now() } = {}) {
  if (!enabledFor(afterDoc)) return { events: [], boss: afterDoc };
  let doc = afterDoc;
  const events = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = doc.bars_broken || 0;
    const target = brokenFromHp(doc);
    if (target <= prev) break;

    const total = totalOf(doc);
    const burstDef = target < total ? bossSkills.skillDef(bcfg().burstSkill) : null;
    const update = { $set: { bars_broken: target, last_bar_break_at: now } };
    if (burstDef) {
      update.$push = {
        active_skills: {
          key: burstDef.key,
          started_at: now,
          expires_at: now + (burstDef.durationSec ?? 60) * 1000,
          hits_at_cast: doc.hits_taken || 0,
        },
      };
    }
    const res = await client.bossEventsCollection.findOneAndUpdate(
      { boss_id: doc.boss_id, bars_broken: { $in: prev === 0 ? [0, null] : [prev] } },
      update,
      { returnDocument: "after" },
    );
    const claimed = res?.value || res;
    if (!claimed) {
      doc = (await client.bossEventsCollection.findOne({ boss_id: doc.boss_id })) || doc;
      continue;
    }

    for (let i = prev; i < target; i++) {
      const payout = await payBar(client, claimed, i, breakerUserId);
      events.push(barEvent(claimed, i, payout, breakerUserId, i + 1 >= total));
    }
    const roundsBefore = rallyCountAt(claimed, prev);
    const roundsAfter = rallyCountAt(claimed, target);
    if (target < total) {
      for (let r = roundsBefore + 1; r <= roundsAfter; r++) events.push(rallyEvent(claimed, r, target));
    }
    doc = claimed;
    break;
  }
  return { events, boss: doc };
}

// ── 顯示 ─────────────────────────────────────────────────
function segmentBar(ratio, len = 12) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * len);
  return "█".repeat(filled) + "░".repeat(len - filled);
}

// 總覽：每條血一格，已打爆 ▱、打到一半 ▰（顏色就是進度）。
function overview(bossDoc) {
  const { index, total } = currentBar(bossDoc);
  const cells = [];
  for (let i = 0; i < total; i++) cells.push(i < index ? "▱" : "▰");
  return cells.join("");
}

// 血量區塊：分段場「第 3/8 條 + 這條還剩多少」，單條場維持原本一條長血條。
function hpBlock(bossDoc, fallbackBar) {
  if (!enabledFor(bossDoc)) return fallbackBar(bossDoc.current_hp ?? 0, bossDoc.max_hp ?? 0);
  const bar = currentBar(bossDoc);
  // 無條件捨去：剛被砍一刀就該看到 99%，而剩一點點血時也不要顯示成 0%。
  const pct = bar.remain > 0 ? Math.max(1, Math.floor(bar.ratio * 100)) : 0;
  return [
    `🩸 **第 ${bar.index + 1}/${bar.total} 條血**　${segmentBar(bar.ratio)} ${pct}%`,
    `-# ${overview(bossDoc)}　已打爆 ${bar.broken} 條・總血量 ${Math.max(0, bossDoc.current_hp ?? 0).toLocaleString()}/${(bossDoc.max_hp ?? 0).toLocaleString()}`,
  ].join("\n");
}

// 這一刀打掉「當前這條血」的幾 %——總血量幾百萬的時候，這個數字才看得出自己有在推進。
function hitPctOfBar(bossDoc, damage) {
  if (!enabledFor(bossDoc) || !damage) return null;
  const per = barHp(bossDoc);
  if (per <= 0) return null;
  const pct = (damage / per) * 100;
  return pct >= 10 ? Math.round(pct) : Number(pct.toFixed(1));
}

// 玩家在「目前這條血」的排名與預估分紅。
function myBarStanding(bossDoc, userId) {
  if (!enabledFor(bossDoc)) return null;
  const { index } = currentBar(bossDoc);
  const { rows, pool } = splitBar(bossDoc, index);
  const idx = rows.findIndex((r) => r.userId === userId);
  if (idx < 0) return { index, rank: null, count: rows.length, coins: 0, pool };
  return { index, rank: idx + 1, count: rows.length, coins: rows[idx].coins, pool };
}

module.exports = {
  bcfg,
  countFor,
  totalOf,
  enabledFor,
  barHp,
  brokenFromHp,
  currentBar,
  barIndexForHit,
  healCap,
  clearRatio,
  counterBonus,
  rallyEnabled,
  rallyCount,
  rallyBonus,
  poolPerBar,
  splitBar,
  processBreaks,
  hpBlock,
  hitPctOfBar,
  myBarStanding,
};
