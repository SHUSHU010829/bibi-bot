require("colors");

const cron = require("node-cron");
const auctionService = require("../../features/auction/auctionService");

// 每 5 分鐘掃過期拍賣品：有人得標 → 撥款 + 交貨；無人 → 退回賣家。
let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function sweepOnce(client) {
  if (!client.auctionListingsCollection) return;

  const now = new Date();
  const cursor = client.auctionListingsCollection.find({
    status: "active",
    expires_at: { $lte: now },
  });

  while (await cursor.hasNext()) {
    const listing = await cursor.next();
    try {
      const res = await auctionService.settleListing(client, listing);
      if (res) {
        console.log(
          `[AUCTION] 結算 #${listing.listing_id} → ${res.outcome}`.gray
        );
      }
    } catch (e) {
      console.log(`[ERROR] auction settle ${listing.listing_id}: ${e}`.red);
    }
  }
}

module.exports = async (client) => {
  if (task) return;

  task = cron.schedule("*/5 * * * *", async () => {
    try {
      await sweepOnce(client);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.log(
        `[ERROR] auctionExpiryScheduler sweep failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[ERROR] 連續錯誤過多，停止拍賣結算 cron`.red);
        task.stop();
      }
    }
  });

  console.log(`[AUCTION] 拍賣結算排程已啟動（每 5 分鐘）`.cyan);
};
