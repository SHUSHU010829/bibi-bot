// 抖內 session 過期排程：每 5 分鐘把 expiresAt 已到的 pending session 翻
// status=expired。MongoDB TTL 設 24 小時當「保留期」，業務上 30 分鐘該過
// 期由這個 cron 處理，避免 webhook 慢送進來時 doc 已被 mongo 刪掉。

require("colors");
const { donation } = require("../../config");
const { registerCron } = require("../../utils/cronRegistry");

async function sweepOnce(client) {
  if (!client.donationSessionsCollection) return { expired: 0 };
  const now = new Date();
  const result = await client.donationSessionsCollection.updateMany(
    { status: "pending", expiresAt: { $lte: now } },
    { $set: { status: "expired", expiredAt: now } },
  );
  return { expired: result.modifiedCount || 0 };
}

module.exports = async (client) => {
  if (!donation?.enabled) return;
  registerCron(client, {
    name: "donation.sessionExpiry",
    label: "抖內 session 過期掃描",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
