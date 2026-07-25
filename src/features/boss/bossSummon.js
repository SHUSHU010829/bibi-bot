require("colors");
const { boss, serverId } = require("../../config");
const bossEngine = require("./bossEngine");
const bossAnnouncer = require("./bossAnnouncer");

// 「討伐能量」召喚機制：
// - 玩家打地下城（通關 / 擊敗 mini-BOSS）累積公會共用的討伐能量。
// - 能量集滿 threshold 且當下沒有魔王在場 → 立刻召喚一隻額外魔王，能量歸零。
// - 每週召喚場次有上限（maxPerWeek），避免無限刷。
// - 同時：地下城通關會給「本場專屬」的個人額外攻擊次數（掛在進行中的 boss doc）。
// 存來源不存結果：能量與召喚次數存在 BossSummonState，個人加成存在 boss doc。

function cfg() {
  return boss?.summon || {};
}

// ISO 週次 key（Asia/Taipei 大致對齊；週界誤差不影響防刷語意）
function weekKey(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function getState(client, guildId) {
  if (!client.bossSummonStateCollection) return null;
  const doc = await client.bossSummonStateCollection.findOne({ guild_id: guildId });
  return doc || { guild_id: guildId, energy: 0, contributors: {}, summoned_count: 0, week_key: null };
}

async function capEnergy(client, guildId, threshold) {
  await client.bossSummonStateCollection.updateOne(
    { guild_id: guildId, energy: { $gt: threshold } },
    { $set: { energy: threshold, updated_at: new Date() } },
  ).catch(() => {});
}

// 進行中魔王：本場專屬個人額外攻擊次數 +n（上限 maxBonusAttacksPerPlayer）
async function grantBonusAttack(client, { userId, guildId, bossId }) {
  const inc = cfg().bonusAttackPerDungeonClear ?? 1;
  const cap = cfg().maxBonusAttacksPerPlayer ?? 5;
  if (inc <= 0 || cap <= 0) return;
  const doc = await client.bossEventsCollection.findOne({ boss_id: bossId, status: "active" });
  if (!doc) return;
  const current = (doc.bonus_attacks || {})[userId] || 0;
  if (current >= cap) return;
  const next = Math.min(cap, current + inc);
  await client.bossEventsCollection.updateOne(
    { boss_id: bossId, status: "active" },
    { $set: { [`bonus_attacks.${userId}`]: next, updatedAt: new Date() } },
  ).catch(() => {});
}

// 集滿時嘗試召喚（原子搶結算權，只有一個 dungeon clear 會真的召出魔王）
async function trySummon(client, guildId) {
  const threshold = cfg().energyThreshold ?? 120;
  const active = await bossEngine.getActiveBoss(client, guildId);
  if (active) {
    await capEnergy(client, guildId, threshold);
    return null;
  }
  const wk = weekKey();
  const state = await getState(client, guildId);
  const summonedThisWeek = state.week_key === wk ? (state.summoned_count || 0) : 0;
  if (summonedThisWeek >= (cfg().maxPerWeek ?? 3)) {
    await capEnergy(client, guildId, threshold);
    return null;
  }

  const claim = await client.bossSummonStateCollection.findOneAndUpdate(
    { guild_id: guildId, energy: { $gte: threshold } },
    {
      $set: {
        energy: 0,
        contributors: {},
        week_key: wk,
        summoned_count: summonedThisWeek + 1,
        updated_at: new Date(),
      },
    },
    { returnDocument: "before" },
  );
  const claimed = claim?.value || claim;
  if (!claimed) return null; // 別的 dungeon clear 已搶先召喚

  const res = await bossEngine.spawnBoss(client, { guildId, spawnSource: "summon" });
  if (!res.ok) return null; // 極端情況：期間已有 boss，能量已消耗，下週再來

  const contributorCount = Object.keys(claimed.contributors || {}).length;
  console.log(`[BOSS] summon spawned ${res.boss.boss_id} by ${contributorCount} contributors`.cyan);
  await bossAnnouncer
    .announceSpawn(client, res.boss, { summon: true, contributorCount })
    .catch((e) => console.log(`[BOSS] summon announce failed: ${e.message}`.red));
  return res.boss;
}

async function addEnergy(client, { userId, guildId, amount }) {
  if (!cfg().enabled || amount <= 0) return;
  if (!client.bossSummonStateCollection) return;
  const threshold = cfg().energyThreshold ?? 120;
  const res = await client.bossSummonStateCollection.findOneAndUpdate(
    { guild_id: guildId },
    {
      $inc: { energy: amount, [`contributors.${userId}`]: amount },
      $set: { updated_at: new Date() },
      $setOnInsert: { summoned_count: 0, week_key: null },
    },
    { upsert: true, returnDocument: "after" },
  );
  const doc = res?.value || res;
  if ((doc?.energy || 0) >= threshold) {
    await trySummon(client, guildId).catch((e) =>
      console.log(`[BOSS] trySummon failed: ${e.message}`.red),
    );
  }
}

// dungeon.cleared / dungeon.mini_boss_defeated 的訂閱入口
async function onDungeonCleared(client, { userId, guildId, won }) {
  if (!cfg().enabled || !won) return;
  if (guildId && serverId && guildId !== serverId) return;
  await addEnergy(client, { userId, guildId, amount: cfg().energyPerDungeonClear ?? 3 });
  const active = await bossEngine.getActiveBoss(client, guildId);
  if (active) {
    await grantBonusAttack(client, { userId, guildId, bossId: active.boss_id });
  }
}

async function onMiniBossDefeated(client, { userId, guildId }) {
  if (!cfg().enabled) return;
  if (guildId && serverId && guildId !== serverId) return;
  await addEnergy(client, { userId, guildId, amount: cfg().energyPerMiniBoss ?? 12 });
}

async function progress(client, guildId) {
  const threshold = cfg().energyThreshold ?? 120;
  const state = await getState(client, guildId);
  const wk = weekKey();
  const summonedThisWeek = state?.week_key === wk ? (state.summoned_count || 0) : 0;
  const active = await bossEngine.getActiveBoss(client, guildId);
  return {
    enabled: !!cfg().enabled,
    energy: Math.min(threshold, state?.energy || 0),
    threshold,
    summonedThisWeek,
    maxPerWeek: cfg().maxPerWeek ?? 3,
    contributorCount: Object.keys(state?.contributors || {}).length,
    activeBoss: active,
  };
}

module.exports = {
  cfg,
  weekKey,
  addEnergy,
  grantBonusAttack,
  trySummon,
  onDungeonCleared,
  onMiniBossDefeated,
  progress,
};
