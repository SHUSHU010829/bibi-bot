// 魔王個人戰績：每場結算時，每位參戰者一筆（打了多少血、出幾刀、被反擊幾次），
// 另寫一筆 user_id=null 的場次摘要列。下一場的血量就是用這份數據預估「會來的人大概打得出多少」。
//
// 為什麼不直接讀 BossEvents / BossDamageLogs：前者 30 天就清掉、後者是逐刀紀錄，
// 拿來算「每人近 5 場平均」又慢又短。這裡一場一人一筆，保留 180 天（TTL 錨在 settledAt）。
require("colors");
const { boss } = require("../../config");

function acfg() {
  return boss?.adaptiveHp || {};
}

function col(client) {
  return client.bossPlayerStatsCollection || null;
}

// attackLimit 由 bossEngine 算好傳進來（本場基礎出刀數＋號角），本模組不 require engine 以免循環。
async function recordFight(client, { bossDoc, ranking, logs, killed, barsBroken, attackLimit }) {
  const c = col(client);
  if (!c || !bossDoc) return;
  const settledAt = new Date();
  const itemDmg = new Map();
  for (const l of logs || []) {
    if (l.via_item && !l.is_counter) itemDmg.set(l.user_id, (itemDmg.get(l.user_id) || 0) + (l.damage || 0));
  }
  const base = {
    guild_id: bossDoc.guild_id,
    boss_id: bossDoc.boss_id,
    spawn_source: bossDoc.spawn_source || "scheduled",
    max_hp: bossDoc.max_hp || 0,
    bars_total: bossDoc.bars_total || 1,
    bars_broken: barsBroken || 0,
    killed: !!killed,
    attack_limit: Math.max(1, attackLimit || 1),
    fight_started_at: bossDoc.started_at || Date.now(),
    settledAt,
  };
  const totalDamage = (ranking || []).reduce((s, r) => s + (r.damage || 0), 0);
  // 打死的場次，傷害被血量封頂（剩下的刀砍不出去），直接拿來預估會讓下一場血量長不上去。
  // 補上「剩餘刀數 × 本場每刀平均 × unusedHitWeight」當作潛在輸出；權重保守，不是每個人都會砍滿。
  const unusedWeight = acfg().unusedHitWeight ?? 0.5;
  const capacityOf = (r, hits) => {
    const dmg = r.damage || 0;
    if (!killed || hits <= 0) return dmg;
    const unused = Math.max(0, base.attack_limit - hits);
    return Math.round(dmg + unused * (dmg / hits) * unusedWeight);
  };
  const ops = (ranking || []).map((r) => ({
    updateOne: {
      filter: { boss_id: bossDoc.boss_id, user_id: r.userId },
      update: {
        $set: {
          ...base,
          user_id: r.userId,
          username: r.username || "",
          damage: r.damage || 0,
          item_damage: itemDmg.get(r.userId) || 0,
          hits: Math.max(0, (r.attacks || 0) - (r.counters || 0)),
          counters: r.counters || 0,
          capacity_damage: capacityOf(r, Math.max(0, (r.attacks || 0) - (r.counters || 0))),
        },
      },
      upsert: true,
    },
  }));
  ops.push({
    updateOne: {
      filter: { boss_id: bossDoc.boss_id, user_id: null },
      update: {
        $set: {
          ...base,
          user_id: null,
          participants: (ranking || []).length,
          total_damage: totalDamage,
          hp_ratio: bossDoc.hp_ratio ?? null,
        },
      },
      upsert: true,
    },
  });
  await c.bulkWrite(ops, { ordered: false })
    .catch((e) => console.log(`[BOSS] 戰績寫入失敗 ${bossDoc.boss_id}: ${e.message}`.red));
}

// 最近的場次摘要。同類型場次夠多就只看同類型（週六場和召喚場來的人不一樣），不夠才混著看。
async function recentFights(client, guildId, spawnSource, limit) {
  const c = col(client);
  if (!c) return { fights: [], scope: "none" };
  const n = limit ?? acfg().windowFights ?? 10;
  const same = spawnSource
    ? await c.find({ guild_id: guildId, user_id: null, spawn_source: spawnSource })
      .sort({ fight_started_at: -1 }).limit(n).toArray().catch(() => [])
    : [];
  if (same.length >= (acfg().minFights ?? 3)) return { fights: same, scope: "same" };
  const all = await c.find({ guild_id: guildId, user_id: null })
    .sort({ fight_started_at: -1 }).limit(n).toArray().catch(() => []);
  return { fights: all, scope: "all" };
}

// 近期權重平均：rows 已依時間新到舊排好，第 i 筆權重 decay^i。
function weightedAvg(values, decay) {
  let sum = 0;
  let w = 0;
  values.forEach((v, i) => {
    const wi = Math.pow(decay, i);
    sum += v * wi;
    w += wi;
  });
  return w > 0 ? sum / w : 0;
}

// 預估下一場「全場打得出多少傷害」：
//   每位近期出現過的玩家：出席率 × 近 N 場每刀平均（新的權重高）× 本場出刀數，全部加總；
//   再加上「新面孔」的平均貢獻（近期每場平均冒出幾個新人 × 新人首場每刀平均）。
// 每刀平均＝damage / attack_limit：用「可出刀數」而不是實際出刀數，體力不夠、沒打滿的人自然算得比較低。
async function forecast(client, guildId, spawnSource, hitsPerPlayer) {
  const a = acfg();
  const c = col(client);
  const { fights, scope } = await recentFights(client, guildId, spawnSource);
  if (!c || fights.length < (a.minFights ?? 3)) return null;

  const bossIds = fights.map((f) => f.boss_id);
  const windowRows = await c.find({ guild_id: guildId, boss_id: { $in: bossIds }, user_id: { $ne: null } })
    .toArray().catch(() => []);
  const attendance = new Map();
  for (const r of windowRows) attendance.set(r.user_id, (attendance.get(r.user_id) || 0) + 1);
  const userIds = [...attendance.keys()];
  if (!userIds.length) return null;

  // 個人近況不分場次類型（已用每刀平均換算過），取每人最近 perPlayerFights 場。
  const perN = a.perPlayerFights ?? 5;
  const decay = a.recencyDecay ?? 0.85;
  const history = await c.find({ guild_id: guildId, user_id: { $in: userIds } })
    .sort({ fight_started_at: -1 }).toArray().catch(() => []);
  const byUser = new Map();
  for (const r of history) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  const players = [];
  for (const uid of userIds) {
    const rows = byUser.get(uid) || [];
    const recent = rows.slice(0, perN);
    const perSlot = weightedAvg(
      recent.map((r) => (r.capacity_damage ?? r.damage ?? 0) / Math.max(1, r.attack_limit || 1)),
      decay,
    );
    const rate = attendance.get(uid) / fights.length;
    players.push({
      userId: uid,
      username: recent[0]?.username || "",
      attendance: rate,
      perSlot,
      fightsSeen: rows.length,
      expected: rate * perSlot * hitsPerPlayer,
    });
  }
  players.sort((x, y) => y.expected - x.expected);
  const regulars = players.reduce((s, p) => s + p.expected, 0);

  // 新面孔：在這個視窗裡第一次出現（保留期間內最早的一筆就落在視窗內）的人。
  // 視窗最舊那一場不算：資料就從那裡開始，那場的人只是「看不到更早的紀錄」，不是新人。
  let newcomer = 0;
  let newcomerPerFight = 0;
  if (a.newcomerAllowance && fights.length > 1) {
    const oldest = fights[fights.length - 1].boss_id;
    const windowSet = new Set(bossIds.filter((id) => id !== oldest));
    const firsts = [];
    for (const uid of userIds) {
      const rows = byUser.get(uid) || [];
      const first = rows[rows.length - 1];
      if (first && windowSet.has(first.boss_id)) firsts.push((first.damage || 0) / Math.max(1, first.attack_limit || 1));
    }
    newcomerPerFight = firsts.length / (fights.length - 1);
    const avgFirst = firsts.length ? firsts.reduce((s, v) => s + v, 0) / firsts.length : 0;
    newcomer = newcomerPerFight * avgFirst * hitsPerPlayer;
  }

  return {
    expected: regulars + newcomer,
    regulars,
    newcomer,
    newcomerPerFight,
    hitsPerPlayer,
    fights: fights.length,
    scope,
    players,
  };
}

// 個人戰績：最近 N 場 + 平均 / 最佳 / 出席率（出席率以同期間的場次摘要為分母）。
async function playerSummary(client, guildId, userId, limit = 10) {
  const c = col(client);
  if (!c) return null;
  const rows = await c.find({ guild_id: guildId, user_id: userId })
    .sort({ fight_started_at: -1 }).limit(limit).toArray().catch(() => []);
  if (!rows.length) return { rows: [] };
  const fights = await c.find({ guild_id: guildId, user_id: null })
    .sort({ fight_started_at: -1 }).limit(limit).toArray().catch(() => []);
  const fightIds = new Set(fights.map((f) => f.boss_id));
  const attended = rows.filter((r) => fightIds.has(r.boss_id)).length;
  const totalDmg = rows.reduce((s, r) => s + (r.damage || 0), 0);
  const totalSlots = rows.reduce((s, r) => s + Math.max(1, r.attack_limit || 1), 0);
  const best = rows.reduce((b, r) => (!b || r.damage > b.damage ? r : b), null);
  return {
    rows,
    avgDamage: totalDmg / rows.length,
    perSlot: totalSlots > 0 ? totalDmg / totalSlots : 0,
    best,
    attendance: fights.length ? attended / fights.length : null,
    windowFights: fights.length,
  };
}

module.exports = { recordFight, recentFights, forecast, playerSummary };
