require("colors");
const { DateTime } = require("luxon");
const { work } = require("../../config");
const grantCoins = require("../economy/grantCoins");

const TZ = "Asia/Taipei";

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
  const min = work.minReward ?? 80;
  const max = work.maxReward ?? 120;
  const amount = Math.floor(Math.random() * (max - min + 1)) + min;

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

  const cooldownMs = work.cooldownMs ?? 14400000;
  const newCooldownAt = now + cooldownMs;
  await client.workProfilesCollection.updateOne(
    { userId, guildId },
    {
      $set: { work_cooldown_at: newCooldownAt, updatedAt: new Date() },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
    },
    { upsert: true }
  );

  return {
    ok: true,
    job,
    amount,
    balance: grant.doc?.totalCoins ?? 0,
    newCooldownAt,
    claimsToday: claimsToday + 1,
    maxClaims,
  };
}

module.exports = { doWork };
