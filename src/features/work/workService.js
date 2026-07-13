require("colors");
const { DateTime } = require("luxon");
const { work } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");
const { getFoodWorkBonus, consumeWorkIncomeUse, formatFoodBuffLines } = require("../fishing/cookService");
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

// 依 key 取工作類型定義；找不到（或未設定）時退回第一種，再退回一個中性預設。
function resolveWorkType(key) {
  const types = work?.workTypes;
  if (!Array.isArray(types) || types.length === 0) {
    return { key: "default", name: "打工", emoji: "💼", events: [] };
  }
  return types.find((t) => t.key === key) || types[0];
}

// 依 weight 從事件表擲骰。空表或全 0 權重時回傳一個中性 normal 事件（mult=1）。
function rollWorkEvent(type) {
  const events = Array.isArray(type?.events) ? type.events : [];
  const total = events.reduce((sum, e) => sum + (e.weight || 0), 0);
  if (total <= 0) return { key: "normal", mult: 1, tier: "normal" };
  let roll = Math.random() * total;
  for (const e of events) {
    roll -= e.weight || 0;
    if (roll < 0) return e;
  }
  return events[events.length - 1];
}

// 打工可用性檢查（冷卻 / 每日上限）。供指令層在顯示選項前先擋、button handler 執行前再擋一次。
// 回傳成功時附帶 profile 與 claimsToday，讓 doWork 免得重查。
async function checkAvailability(client, { userId, guildId }) {
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

  return { ok: true, profile, claimsToday, maxClaims };
}

// 執行一次打工。workTypeKey 決定工作類型（穩定 / 拚一波），連帶決定事件表。
// 每日次數用 CoinTransactions(source=work) 當日筆數判定，免額外計數欄位。
async function doWork(client, { userId, guildId, member, username, workTypeKey }) {
  const avail = await checkAvailability(client, { userId, guildId });
  if (!avail.ok) return avail;

  const now = Date.now();
  const profile = avail.profile;
  const claimsToday = avail.claimsToday;
  const maxClaims = avail.maxClaims;

  const workType = resolveWorkType(workTypeKey);

  const jobs = work.jobs || [];
  const job = jobs.length
    ? jobs[Math.floor(Math.random() * jobs.length)]
    : "打了一份零工";
  // 依目前累計次數（升級前）決定報酬區間
  const workCount = profile?.work_count_total || 0;
  const levelInfo = resolveWorkLevel(workCount);
  const min = levelInfo.minReward;
  const max = levelInfo.maxReward;
  const baseAmount = Math.floor(Math.random() * (max - min + 1)) + min;

  // 隨機事件倍率（小費 / 大獎 / 衰事…），同一事件從台詞池隨機挑一句
  const event = rollWorkEvent(workType);
  const eventMult = event.mult ?? 1;
  const eventText = Array.isArray(event.texts) && event.texts.length
    ? event.texts[Math.floor(Math.random() * event.texts.length)]
    : event.text || null;

  // 食物 buff：work_income / all_boost 類型加成
  let foodWorkBonus = 0;
  let miningProfile = null;
  try {
    miningProfile = await getMiningProfile(client, userId, guildId).catch(() => null);
    if (miningProfile) {
      foodWorkBonus = getFoodWorkBonus(miningProfile);
    }
  } catch { /* 讀不到 profile 就忽略食物加成 */ }

  const amount = Math.max(1, Math.floor(baseAmount * eventMult * (1 + foodWorkBonus)));

  const grant = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount,
    source: "work",
    member,
    meta: { job, workType: workType.key, event: event.key },
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
    workType,
    event,
    eventMult,
    eventText,
    amount: grant.granted,
    baseAmount,
    foodWorkBonus,
    foodBuffLines: miningProfile ? formatFoodBuffLines(miningProfile, "work") : [],
    guildWorkBonus,
    balance: grant.doc?.totalCoins ?? 0,
    newCooldownAt,
    claimsToday: claimsToday + 1,
    maxClaims,
    level: nextLevelInfo.level,
    levelName: nextLevelInfo.name,
    nextLevel: nextLevelInfo.nextLevel,
    nextLevelName: nextLevelInfo.nextLevelName,
    toNext: nextLevelInfo.toNext,
    countTotal: newCount,
  };
}

module.exports = { doWork, checkAvailability, resolveWorkType };
