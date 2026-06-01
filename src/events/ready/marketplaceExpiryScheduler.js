require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const marketplaceService = require("../../features/marketplace/marketplaceService");

// 每 5 分鐘掃過期市集掛單：
// - auction 有得標者 → 撥款 + 交貨；無人 → 退回賣家礦石
// - sell / barter / want → 退回託管的礦石或金幣

async function sweepOnce(client) {
  if (!client.marketListingsCollection) return { settled: 0 };

  const now = new Date();
  const cursor = client.marketListingsCollection.find({
    status: "active",
    expires_at: { $lte: now },
  });

  let settled = 0;
  while (await cursor.hasNext()) {
    const listing = await cursor.next();
    try {
      const res = await marketplaceService.settleListing(client, listing);
      if (res) {
        settled += 1;
        console.log(`[MARKET] 結算 #${listing.listing_id}(${listing.listing_type}) → ${res.outcome}`.gray);
      }
    } catch (e) {
      console.log(`[ERROR] market settle ${listing.listing_id}: ${e}`.red);
    }
  }
  return { settled };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "marketplace.expiry",
    label: "市集掛單到期結算",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
