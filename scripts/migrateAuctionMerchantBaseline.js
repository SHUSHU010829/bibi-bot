require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 把 legacy AuctionListings 已成交筆數寫進 UserLevels.legacy_auction_sold_count，
 * 讓拍賣商人頭銜（auction_merchant）的進度切換到 MarketListings 後不歸零。
 *
 * 執行方式：
 *   node scripts/migrateAuctionMerchantBaseline.js          # dry-run，列出每位玩家的 sold 筆數
 *   node scripts/migrateAuctionMerchantBaseline.js apply    # 實際寫入 UserLevels
 *
 * 必須在 drop AuctionListings collection 之前執行；執行後即可安全 drop。
 */

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const database = mongoClient.db("MorningBot");
    const auctionListingsCollection = database.collection("AuctionListings");
    const userLevelsCollection = database.collection("UserLevels");

    const collections = await database.listCollections({ name: "AuctionListings" }).toArray();
    if (collections.length === 0) {
      console.log("[INFO] AuctionListings collection 不存在，無事可做。".cyan);
      return;
    }

    const aggregated = await auctionListingsCollection
      .aggregate([
        { $match: { status: "sold" } },
        {
          $group: {
            _id: { sellerId: "$seller_id", guildId: "$guild_id" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();

    if (aggregated.length === 0) {
      console.log("[INFO] AuctionListings 沒有任何 sold 記錄，無事可做。".cyan);
      return;
    }

    console.log(`\n[INFO] 找到 ${aggregated.length} 組 (seller, guild) 有歷史成交：`.yellow);
    console.log("─".repeat(72));
    console.log("  seller_id".padEnd(24) + "guild_id".padEnd(24) + "sold");
    console.log("─".repeat(72));
    for (const row of aggregated.slice(0, 30)) {
      const { sellerId, guildId } = row._id;
      console.log(
        `  ${String(sellerId).padEnd(22)}  ${String(guildId).padEnd(22)}  ${row.count}`
      );
    }
    if (aggregated.length > 30) {
      console.log(`  ... 還有 ${aggregated.length - 30} 組未顯示`.gray);
    }
    console.log("─".repeat(72));

    if (!shouldApply) {
      console.log("\n[DRY-RUN] 未實際寫入。".cyan);
      console.log("[提示] 確認沒問題後，加 'apply' 參數實際寫入：".cyan);
      console.log("  node scripts/migrateAuctionMerchantBaseline.js apply".white);
      return;
    }

    console.log("\n[WARNING] 5 秒後開始寫入 UserLevels.legacy_auction_sold_count，按 Ctrl+C 取消…".yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    let updated = 0;
    let inserted = 0;
    for (const row of aggregated) {
      const { sellerId, guildId } = row._id;
      const res = await userLevelsCollection.updateOne(
        { userId: sellerId, guildId },
        {
          $set: {
            legacy_auction_sold_count: row.count,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );
      if (res.upsertedCount) inserted++;
      else if (res.modifiedCount) updated++;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 完成：更新 ${updated} 筆，新建 ${inserted} 筆`.green);
    console.log("=".repeat(60));
    console.log("\n[INFO] 之後可以安全執行 db.AuctionListings.drop()。".cyan);
  } catch (error) {
    console.log(`[ERROR] 遷移失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
