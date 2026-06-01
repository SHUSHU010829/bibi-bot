require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const auctionService = require("../../features/auction/auctionService");

// 每 5 分鐘掃過期拍賣品：有人得標 → 撥款 + 交貨；無人 → 退回賣家。

async function sweepOnce(client) {
  if (!client.auctionListingsCollection) return { settled: 0 };

  const now = new Date();
  const cursor = client.auctionListingsCollection.find({
    status: "active",
    expires_at: { $lte: now },
  });

  let settled = 0;
  while (await cursor.hasNext()) {
    const listing = await cursor.next();
    try {
      const res = await auctionService.settleListing(client, listing);
      if (res) {
        settled += 1;
        console.log(
          `[AUCTION] 結算 #${listing.listing_id} → ${res.outcome}`.gray
        );
      }
    } catch (e) {
      console.log(`[ERROR] auction settle ${listing.listing_id}: ${e}`.red);
    }
  }
  return { settled };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "auction.expiry",
    label: "拍賣到期結算",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
