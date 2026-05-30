require("colors");
const cron = require("node-cron");
const marketplaceService = require("../../features/marketplace/marketplaceService");

// 每 5 分鐘掃過期市集掛單：
// - auction 有得標者 → 撥款 + 交貨；無人 → 退回賣家礦石
// - sell / barter / want → 退回託管的礦石或金幣
let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function sweepOnce(client) {
  if (!client.marketListingsCollection) return;

  const now = new Date();
  const cursor = client.marketListingsCollection.find({
    status: "active",
    expires_at: { $lte: now },
  });

  while (await cursor.hasNext()) {
    const listing = await cursor.next();
    try {
      const res = await marketplaceService.settleListing(client, listing);
      if (res) {
        console.log(`[MARKET] 結算 #${listing.listing_id}(${listing.listing_type}) → ${res.outcome}`.gray);
      }
    } catch (e) {
      console.log(`[ERROR] market settle ${listing.listing_id}: ${e}`.red);
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
        `[ERROR] marketplaceExpiryScheduler sweep failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[ERROR] 連續錯誤過多，停止市集結算 cron`.red);
        task.stop();
      }
    }
  });

  console.log(`[MARKET] 市集結算排程已啟動（每 5 分鐘）`.cyan);
};
