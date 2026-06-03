require("colors");
const { DateTime } = require("luxon");
const { work } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");
const { getFoodWorkBonus, getActiveFoodBuffs, consumeWorkIncomeUse } = require("../fishing/cookService");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");

const TZ = "Asia/Taipei";

// 依累計打工次數決定當前等級，回傳 { level, name, minReward, maxReward, nextLevel, toNext }。
// 若 work.levels 未設定，fallback 到頂層 minReward/maxReward，level=null。
function resolveWorkLevel(count) {
  const levels = work?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    return {
      level: null,
      name: null,
      minReward: work?.minReward ?? 80,
      maxReward: work?.maxReward ?? 120,
      nextLevel: null,
      toNext: null,
    };
  }
  // 找 minCount <= count 的最高一級（levels 假設已由小到大排序）
  let current = levels[0];
  for (const lv of levels) {
    if ((lv.minCount ?? 0) <= count) current = lv;
    else break;
  }
  const idx = levels.indexOf(current);
  const nextLevel = idx + 1 < levels.length ? levels[idx + 1] : null;
  return {
    level: current.level,
    name: current.name,
    minReward: current.minReward ?? work?.minReward ?? 80,
    maxReward: current.maxReward ?? work?.maxReward ?? 120,
    nextLevel: nextLevel ? nextLevel.level : null,
    nextLevelName: nextLevel ? nextLevel.name : null,
    toNext: nextLevel ? nextLevel.minCount - count : null,
  };
}

// 執行一次打工。每日次數用 CoinTransactions(source=work) 當日筆數判定，免額外計數欄位。
async function doWork(client, { userId, guildId, member, username }) {
  if (!work?.enabled) return { ok: false, reason: "disabled" };
  if (!client.workProfilesCollection || !client.coinTransactionsCollection) {
    return { ok: false, reason: "disabled" };
  }

  const now = Date.now();
  const profile = await client.workProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);

  if ((profile?.work_cooldown_at || 0) > now) {
    return { ok: false, reason: "cooldown", readyAt: profile.work_cooldown_at };
  }

  const today = DateTime.now().setZone(TZ).toISODate();
  const claimsToday = await client.coinTransactionsCollection
    .countDocuments({ userId, guildId, source: "work", date: today })
    .catch(() => 0);
  const maxClaims = work.dailyMaxClaims ?? 6;
  if (claimsToday >= maxClaims) {
    const resetAt = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf("day");
    return {
      ok: false,
      reason: "daily_limit",
      claimsToday,
      maxClaims,
      resetEpoch: Math.floor(resetAt.toSeconds()),
    };
  }

  const jobs = work.jobs || [];
  const job = jobs.length
    ? jobs[Math.floor(Math.random() * jobs.length)]
    : "打了一份零工";
  // 依目前累計次數（升級前）決定報酬區間
  const workCount = profile?.work_count_total || 0;
  const levelInfo = resolveWorkLevel(workCount);
  const min = levelInfo.minReward;
  const max = levelInfo.maxReward;
  let baseAmount = Math.floor(Math.random() * (max - min + 1)) + min;

  // 食物 buff：work_income / all_boost 類型加成
  let foodWorkBonus = 0;
  let miningProfile = null;
  try {
    miningProfile = await getMiningProfile(client, userId, guildId).catch(() => null);
    if (miningProfile) {
      foodWorkBonus = getFoodWorkBonus(miningProfile);
    }
  } catch { /* 讀不到 profile 就忽略食物加成 */ }

  const amount = foodWorkBonus > 0
    ? Math.floor(baseAmount * (1 + foodWorkBonus))
    : baseAmount;

  const grant = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount,
    source: "work",
    member,
    meta: { job },
  });
  if (!grant) return { ok: false, reason: "grant_failed" };

  // 次數型「魚排便當」buff：本次打工套用後消耗一次（非阻塞；只扣 work_income 型）
  if (miningProfile) {
    consumeWorkIncomeUse(client, userId, guildId, miningProfile).catch(() => {});
  }

  let cooldownMs = work.cooldownMs ?? 14400000;
  // Twitch 訂閱者權益：縮短打工 CD
  const perks = twitchPerks.resolvePerks(member);
  if (perks?.workCdReductionMs) {
    cooldownMs = Math.max(60 * 1000, cooldownMs - perks.workCdReductionMs);
  }
  const newCooldownAt = now + cooldownMs;
  await client.workProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { work_count_total: 1 },
      $set: { work_cooldown_at: newCooldownAt, updatedAt: new Date() },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
    },
    { upsert: true }
  );

  // 解析下一等級（升級後的新 count）
  const newCount = workCount + 1;
  const nextLevelInfo = resolveWorkLevel(newCount);

  const guildWorkBonus = (grant.guildWorkMultiplier || 1) - 1;
  return {
    ok: true,
    job,
    amount: grant.granted,
    baseAmount,
    foodWorkBonus,
    guildWorkBonus,
    balance: grant.doc?.totalCoins ?? 0,
    newCooldownAt,
    claimsToday: claimsToday + 1,
    maxClaims,
    level: levelInfo.level,
    levelName: levelInfo.name,
    nextLevel: nextLevelInfo.nextLevel,
    nextLevelName: nextLevelInfo.nextLevelName,
    toNext: nextLevelInfo.toNext,
    countTotal: newCount,
  };
}

module.exports = { doWork };
