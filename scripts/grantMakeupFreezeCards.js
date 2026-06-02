require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 補發補簽卡腳本
 *
 * 背景：伺服器問題導致部分玩家無法簽到，補發給所有「曾經簽到過」的玩家
 *      每人 2 張補簽卡（庫存上限暫時放寬到 5 張）。
 *
 * 執行方式：
 *   node scripts/grantMakeupFreezeCards.js          # dry-run，只列出會被影響的人數
 *   node scripts/grantMakeupFreezeCards.js apply    # 實際寫入
 */

const GRANT_AMOUNT = 2;
const TEMP_CAP = 5;

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
    const userLevelsCollection = database.collection("UserLevels");
    const dailyCheckinCollection = database.collection("DailyCheckin");

    // 取出所有「曾經簽到過」的 (userId, guildId) 組合
    const targets = await dailyCheckinCollection
      .aggregate([
        { $group: { _id: { userId: "$userId", guildId: "$guildId" } } },
      ])
      .toArray();

    if (targets.length === 0) {
      console.log("[INFO] 沒有任何簽到紀錄，無需補發".yellow);
      return;
    }

    console.log(`\n[INFO] 找到 ${targets.length} 位曾經簽到過的玩家`.cyan);
    console.log(
      `[INFO] 規則：每人 +${GRANT_AMOUNT} 張補簽卡，封頂 ${TEMP_CAP} 張`.cyan
    );

    // Dry-run 統計：抓出目前庫存分布
    const userIds = targets.map((t) => t._id.userId);
    const guildIds = targets.map((t) => t._id.guildId);
    const docs = await userLevelsCollection
      .find({
        userId: { $in: userIds },
        guildId: { $in: guildIds },
      })
      .project({ userId: 1, guildId: 1, streakFreezes: 1 })
      .toArray();

    const docMap = new Map();
    for (const doc of docs) {
      docMap.set(`${doc.userId}_${doc.guildId}`, doc.streakFreezes || 0);
    }

    let willGainTwo = 0;
    let willGainOne = 0;
    let willGainZero = 0;
    let noLevelDoc = 0;
    for (const t of targets) {
      const key = `${t._id.userId}_${t._id.guildId}`;
      if (!docMap.has(key)) {
        noLevelDoc++;
        continue;
      }
      const before = docMap.get(key);
      const after = Math.min(before + GRANT_AMOUNT, TEMP_CAP);
      const gain = after - before;
      if (gain >= 2) willGainTwo++;
      else if (gain === 1) willGainOne++;
      else willGainZero++;
    }

    console.log("\n[預覽] 影響範圍：".cyan);
    console.log(`  +2 張：${willGainTwo} 人`.white);
    console.log(`  +1 張（已接近封頂）：${willGainOne} 人`.white);
    console.log(`  +0 張（已達封頂 ${TEMP_CAP}）：${willGainZero} 人`.white);
    console.log(
      `  無 UserLevels 文件（會 upsert 為 ${GRANT_AMOUNT} 張）：${noLevelDoc} 人`.white
    );

    if (!shouldApply) {
      console.log(
        "\n[INFO] 這是 dry-run。確認無誤後執行 `node scripts/grantMakeupFreezeCards.js apply` 補發".yellow
      );
      return;
    }

    console.log("\n[WARNING] 5 秒後開始補發，按 Ctrl+C 取消...".yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    let updated = 0;
    let upserted = 0;
    for (const t of targets) {
      const { userId, guildId } = t._id;
      const res = await userLevelsCollection.updateOne(
        { userId, guildId },
        [
          {
            $set: {
              streakFreezes: {
                $min: [
                  {
                    $add: [{ $ifNull: ["$streakFreezes", 0] }, GRANT_AMOUNT],
                  },
                  TEMP_CAP,
                ],
              },
              updatedAt: new Date(),
            },
          },
        ],
        { upsert: true }
      );
      if (res.upsertedCount > 0) upserted++;
      else if (res.modifiedCount > 0) updated++;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 補發完成`.green);
    console.log(`  更新既有玩家：${updated} 人`.white);
    console.log(`  新建文件玩家：${upserted} 人`.white);
    console.log(`  未變動（已達封頂）：${targets.length - updated - upserted} 人`.white);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`[ERROR] 補發失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
