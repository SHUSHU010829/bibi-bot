// 抖內 session 過期排程：每 5 分鐘把 expiresAt 已到的 pending session 翻
// status=expired。MongoDB TTL 設 24 小時當「保留期」，業務上 30 分鐘該過
// 期由這個 cron 處理，避免 webhook 慢送進來時 doc 已被 mongo 刪掉。

require("colors");
const cron = require("node-cron");
const { donation } = require("../../config");

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function sweepOnce(client) {
  if (!client.donationSessionsCollection) return 0;
  const now = new Date();
  const result = await client.donationSessionsCollection.updateMany(
    { status: "pending", expiresAt: { $lte: now } },
    { $set: { status: "expired", expiredAt: now } },
  );
  return result.modifiedCount || 0;
}

module.exports = async (client) => {
  if (!donation?.enabled) return;
  if (task) return;

  task = cron.schedule("*/5 * * * *", async () => {
    try {
      const expired = await sweepOnce(client);
      if (expired > 0) {
        console.log(`[DONATION] session 過期掃描：標記 ${expired} 筆為 expired`.gray);
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.log(
        `[ERROR] donationSessionExpiryScheduler failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red,
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[ERROR] 連續錯誤過多，停止 donation session 過期掃描 cron`.red);
        task.stop();
      }
    }
  });

  console.log(`[DONATION] session 過期掃描排程已啟動（每 5 分鐘）`.cyan);
};
