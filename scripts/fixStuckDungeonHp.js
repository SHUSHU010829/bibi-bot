require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 立即修復「地下城 HP 卡在 0、永不自然回復」的玩家。
 *
 * 背景：採集陷阱（毒霧 lose_stamina+hp、礦車失控撞傷）把 HP 打到剛好 0 時，
 * 舊程式錯把 hp_updated_at 設成 0。resolveHp 把 hp_updated_at===0 當成
 * 「滿血、計時停擺」的哨兵值，導致每次讀取都把回復錨點重設為當下、tick 永遠是 0，
 * 玩家就永遠卡在 0 HP。（根因已於 encounterService 修掉，扣血一律寫 Date.now()。）
 *
 * 滿血玩家的 hp_current 至少是 baseMax(100)、不可能為 0，故
 * hp_current:0 + hp_updated_at:0 必為卡住的受害者。把 hp_updated_at 重設為當下，
 * 自然回復計時就會重新開跑（每 10 分鐘 +5）。idempotent，跑幾次都安全。
 *
 * connectDb 已內建同樣的一次性修補，「重啟 bot」也會自動套用；
 * 本腳本用於不想等重啟、想立刻救人的情境。
 *
 * 執行：
 *   node scripts/fixStuckDungeonHp.js          # dry-run，列出將被修復的玩家
 *   node scripts/fixStuckDungeonHp.js apply     # 實際寫入
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
    const collection = database.collection("MiningProfiles");

    const filter = { hp_current: 0, hp_updated_at: 0 };

    const stuck = await collection
      .find(filter, { projection: { userId: 1, guildId: 1 } })
      .toArray();

    if (stuck.length === 0) {
      console.log("[INFO] 沒有任何玩家卡在 0 HP，無需修復。".cyan);
      return;
    }

    console.log(`\n[INFO] ${stuck.length} 位玩家卡在 0 HP（前 30 筆預覽）：`.yellow);
    console.log("─".repeat(60));
    for (const p of stuck.slice(0, 30)) {
      console.log(`  ${String(p.userId).padEnd(20)}  ${String(p.guildId).padEnd(20)}`);
    }
    if (stuck.length > 30) {
      console.log(`  ... 還有 ${stuck.length - 30} 筆未顯示`.gray);
    }
    console.log("─".repeat(60));

    if (!shouldApply) {
      console.log("\n[DRY-RUN] 未實際寫入。".cyan);
      console.log("[提示] 確認沒問題後，加 'apply' 參數實際寫入：".cyan);
      console.log("  node scripts/fixStuckDungeonHp.js apply".white);
      return;
    }

    console.log(`\n[WARNING] 5 秒後重啟 ${stuck.length} 位玩家的回復計時，按 Ctrl+C 取消…`.yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const result = await collection.updateMany(filter, {
      $set: { hp_updated_at: Date.now(), updatedAt: new Date() },
    });

    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 完成：modified ${result.modifiedCount} 筆，自然回復已重新開跑`.green);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`[ERROR] 修復失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
