require("colors");
const { boss, serverId } = require("../../config");
const bossEngine = require("./bossEngine");
const bossAnnouncer = require("./bossAnnouncer");

// 「討伐能量」召喚機制：
// - 玩家打地下城（通關 / 擊敗 mini-BOSS）累積公會共用的討伐能量。
// - 能量集滿 threshold 且當下沒有魔王在場 → 立刻召喚一隻額外魔王，能量歸零。
// - 每週召喚場次有上限（maxPerWeek），避免無限刷。
// - 同時：地下城通關會給個人「攻擊庫存」（存 profile，可事先備戰、跨場使用），
//   任何一場魔王（含週六固定場）都能拿出來多打幾刀，每場最多 maxBonusAttacksPerPlayer 次。
// 存來源不存結果：能量與召喚次數存在 BossSummonState，攻擊庫存存在 profile。

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

// energy 是 contributors 的換算結果，不是獨立的帳：任何時候都由貢獻明細即時算出來
// （每人先套 maxEnergyPerContributor 上限）。
// 以前 energy 會被單獨改寫（滿了就砍到門檻），contributors 卻照舊累積，
// 一旦門檻或每人上限改動，兩邊就永久對不上：貢獻明細顯示三個人各 60，能量卻卡在舊門檻。
function clampContribution(value, perCap) {
  const n = Math.max(0, value || 0);
  return perCap > 0 ? Math.min(perCap, n) : n;
}

function contributorEnergy(contributors, perCap) {
  return Object.values(contributors || {}).reduce((sum, v) => sum + clampContribution(v, perCap), 0);
}

// 把 DB 的 energy 欄位對回貢獻明細（trySummon 的原子搶結算條件要讀這個欄位）。
async function syncEnergy(client, guildId, doc) {
  const energy = contributorEnergy(doc?.contributors, cfg().maxEnergyPerContributor ?? 0);
  if ((doc?.energy || 0) !== energy) {
    await client.bossSummonStateCollection.updateOne(
      { guild_id: guildId },
      { $set: { energy, updated_at: new Date() } },
      { upsert: true },
    ).catch(() => {});
  }
  return energy;
}

// 個人「攻擊庫存」：打地下城累積（存 profile），可事先備戰、任何一場魔王都能用。
// 上限 maxBonusAttacksPerPlayer；每場魔王最多動用這麼多次額外攻擊。
async function grantAttackCharge(client, { userId, guildId }) {
  const inc = cfg().bonusAttackPerDungeonClear ?? 1;
  const cap = cfg().maxBonusAttacksPerPlayer ?? 5;
  if (inc <= 0 || cap <= 0 || !client.miningProfilesCollection) return;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { boss_attack_charges: inc }, $set: { updatedAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
  await client.miningProfilesCollection.updateOne(
    { userId, guildId, boss_attack_charges: { $gt: cap } },
    { $set: { boss_attack_charges: cap } },
  ).catch(() => {});
}

function cooldownMs() {
  return (cfg().spawnCooldownMinutes ?? 0) * 60 * 1000;
}

// 集滿時嘗試召喚（原子搶結算權，只有一個 dungeon clear 會真的召出魔王）
// 招喚場立即登場、無時間限制、血量與固定場同級；並有「防連續出場」冷卻。
// 任何一項條件沒過都只是「掛著等」：能量不歸零、也不砍掉超出門檻的部分，
// 等待期間累積的貢獻不會白花。
async function trySummon(client, guildId) {
  if (!client.bossSummonStateCollection) return null;
  const threshold = cfg().energyThreshold ?? 120;
  const state = await getState(client, guildId);
  const energy = await syncEnergy(client, guildId, state);
  if (energy < threshold) return null;
  const active = await bossEngine.getActiveBoss(client, guildId);
  if (active) return null;
  // 防連續出場：距離上一隻魔王結束還沒過冷卻 → 冷卻過了下次通關（或每分鐘的掃描）再召。
  const cd = await bossEngine.bossCooldown(client, guildId, cooldownMs());
  if (cd.onCooldown) return null;
  const wk = weekKey();
  const summonedThisWeek = state.week_key === wk ? (state.summoned_count || 0) : 0;
  if (summonedThisWeek >= (cfg().maxPerWeek ?? 3)) return null;

  // 人數門檻：世界王是社群事件，不接受「一小撮人刷出來」。能量滿了但人不夠就先掛著等，
  // 不歸零、不消耗週次，之後有新的人加入貢獻時會再跑一次這裡。
  const minContributors = cfg().minContributors ?? 0;
  if (Object.keys(state.contributors || {}).length < minContributors) return null;

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

  const contributorCount = Object.keys(claimed.contributors || {}).length;
  // 立即登場：血量倍率（summonHpMult）、無時間限制（noExpiry），待到被擊殺為止。
  const res = await bossEngine.spawnBoss(client, {
    guildId,
    spawnSource: "summon",
    hpMult: cfg().summonHpMult ?? 1,
    noExpiry: true,
  });
  if (!res.ok) return null; // 極端情況：期間已有 boss，能量已消耗，下週再來

  console.log(`[BOSS] summon spawned ${res.boss.boss_id} hp=${res.boss.max_hp} by ${contributorCount} contributors`.cyan);
  await bossAnnouncer
    .announceSpawn(client, res.boss, { summon: true, contributorCount })
    .catch((e) => console.log(`[BOSS] summon announce failed: ${e.message}`.red));
  return res.boss;
}

async function addEnergy(client, { userId, guildId, amount }) {
  if (!cfg().enabled || amount <= 0) return;
  if (!client.bossSummonStateCollection) return;
  const threshold = cfg().energyThreshold ?? 120;

  // 每人單輪貢獻上限：一個人狂刷地下城不能把整條進度條灌滿，一定要湊到夠多人。
  // 上限扣完之後他的通關只剩「攻擊庫存」的回饋（那個另外算，不受此限）。
  const perCap = cfg().maxEnergyPerContributor ?? 0;
  const state = await getState(client, guildId);
  const mine = (state?.contributors || {})[userId] || 0;
  const grant = perCap > 0 ? Math.min(amount, Math.max(0, perCap - mine)) : amount;

  // 貢獻上限扣完的人也要繼續走到 trySummon：否則「能量已滿、就等冷卻結束」時，
  // 只剩滿貢獻的老手在打地下城 → 沒有任何事件會再去檢查一次條件，魔王永遠不出場。
  let doc = state;
  if (grant > 0) {
    const res = await client.bossSummonStateCollection.findOneAndUpdate(
      { guild_id: guildId },
      {
        $inc: { [`contributors.${userId}`]: grant },
        $set: { updated_at: new Date() },
        $setOnInsert: { summoned_count: 0, week_key: null },
      },
      { upsert: true, returnDocument: "after" },
    );
    doc = res?.value || res || state;
  }
  const energy = await syncEnergy(client, guildId, doc);
  if (energy >= threshold) {
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
  await grantAttackCharge(client, { userId, guildId });
}

async function onMiniBossDefeated(client, { userId, guildId }) {
  if (!cfg().enabled) return;
  if (guildId && serverId && guildId !== serverId) return;
  await addEnergy(client, { userId, guildId, amount: cfg().energyPerMiniBoss ?? 12 });
}

async function progress(client, guildId, userId) {
  const threshold = cfg().energyThreshold ?? 120;
  const chargeCap = cfg().maxBonusAttacksPerPlayer ?? 5;
  const state = await getState(client, guildId);
  const wk = weekKey();
  const summonedThisWeek = state?.week_key === wk ? (state.summoned_count || 0) : 0;
  const active = await bossEngine.getActiveBoss(client, guildId);
  const cd = await bossEngine.bossCooldown(client, guildId, cooldownMs());
  let myCharges = 0;
  if (userId && client.miningProfilesCollection) {
    const profile = await client.miningProfilesCollection
      .findOne({ userId, guildId })
      .catch(() => null);
    myCharges = Math.min(chargeCap, Math.max(0, profile?.boss_attack_charges || 0));
  }
  const contributors = state?.contributors || {};
  const perCap = cfg().maxEnergyPerContributor ?? 0;
  const values = Object.values(contributors);
  // 現有貢獻者「還能貢獻多少」：全員貢獻上限扣完時能量條就再也不會動，
  // 這時要講清楚缺的是新的人，而不是再多打幾場地下城。
  const headroom = perCap > 0
    ? values.reduce((sum, v) => sum + Math.max(0, perCap - clampContribution(v, perCap)), 0)
    : Infinity;
  return {
    enabled: !!cfg().enabled,
    energy: Math.min(threshold, contributorEnergy(contributors, perCap)),
    threshold,
    summonedThisWeek,
    maxPerWeek: cfg().maxPerWeek ?? 3,
    contributorCount: values.length,
    cappedContributors: perCap > 0 ? values.filter((v) => (v || 0) >= perCap).length : 0,
    contributorHeadroom: headroom,
    minContributors: cfg().minContributors ?? 0,
    myEnergy: userId ? clampContribution(contributors[userId], perCap) : 0,
    perContributorCap: perCap,
    activeBoss: active,
    cooldownUntil: cd.onCooldown ? cd.until : 0,
    cooldownMinutes: cfg().spawnCooldownMinutes ?? 0,
    energyPerClear: cfg().energyPerDungeonClear ?? 0,
    energyPerMiniBoss: cfg().energyPerMiniBoss ?? 0,
    myCharges,
    chargeCap,
  };
}

module.exports = {
  cfg,
  weekKey,
  addEnergy,
  grantAttackCharge,
  trySummon,
  onDungeonCleared,
  onMiniBossDefeated,
  progress,
};
