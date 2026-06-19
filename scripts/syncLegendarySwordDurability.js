require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");
const dungeon = require("../src/config/dungeon.json");

/**
 * 把所有「裝備傳說之劍」的玩家 weapon_max_durability 同步成 config 當前值，
 * 並把新舊 max 的差額加到 weapon_durability（讓舊玩家獲得耐久提升），
 * 最後 clamp 到新 max。
 *
 * 用途：傳說之劍耐久從 80 → 120 後，幫舊玩家一次補上 +40 max / +40 current。
 *
 * 執行：
 *   node scripts/syncLegendarySwordDurability.js          # dry-run，列出將被更動的玩家
 *   node scripts/syncLegendarySwordDurability.js apply    # 實際寫入
 */

const WEAPON_ID = "legendary_sword";
const weaponDefs = dungeon.dungeon?.weapons || dungeon.weapons || {};
const NEW_MAX = weaponDefs[WEAPON_ID]?.durability;

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  if (typeof NEW_MAX !== "number") {
    console.log(`[ERROR] 讀不到 ${WEAPON_ID} 的 durability 設定，請檢查 config 路徑`.red);
    process.exit(1);
  }

  console.log(`[INFO] 傳說之劍當前 config durability = ${NEW_MAX}`.cyan);

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const database = mongoClient.db("MorningBot");
    const collection = database.collection("MiningProfiles");

    const profiles = await collection
      .find(
        { weapon: WEAPON_ID },
        {
          projection: {
            userId: 1,
            guildId: 1,
            weapon: 1,
            weapon_durability: 1,
            weapon_max_durability: 1,
          },
        }
      )
      .toArray();

    console.log(`[INFO] 共 ${profiles.length} 位玩家裝備傳說之劍`.cyan);

    const ops = [];
    const samplePreview = [];

    for (const p of profiles) {
      const oldMax = p.weapon_max_durability;
      const oldCur = p.weapon_durability;

      if (oldMax === NEW_MAX) continue;

      const set = { weapon_max_durability: NEW_MAX };
      const diffs = [`max ${oldMax ?? "—"}→${NEW_MAX}`];

      // 把 max 提升的差額補到當前耐久，讓舊玩家拿到升級紅利；若降低則 clamp。
      if (typeof oldCur === "number") {
        const diff = NEW_MAX - (oldMax ?? oldCur);
        let nextCur = oldCur + diff;
        if (nextCur < 0) nextCur = 0;
        if (nextCur > NEW_MAX) nextCur = NEW_MAX;
        if (nextCur !== oldCur) {
          set.weapon_durability = nextCur;
          diffs.push(`cur ${oldCur}→${nextCur}`);
        }
      }

      set.updatedAt = new Date();
      ops.push({
        updateOne: {
          filter: { userId: p.userId, guildId: p.guildId },
          update: { $set: set },
        },
      });

      if (samplePreview.length < 30) {
        samplePreview.push({
          userId: p.userId,
          guildId: p.guildId,
          diffs: diffs.join(" / "),
        });
      }
    }

    if (ops.length === 0) {
      console.log("[INFO] 沒有任何玩家需要同步，已是最新狀態。".cyan);
      return;
    }

    console.log(`\n[INFO] ${ops.length} 筆 profile 將被更新（前 30 筆預覽）：`.yellow);
    console.log("─".repeat(96));
    for (const row of samplePreview) {
      console.log(
        `  ${String(row.userId).padEnd(20)}  ${String(row.guildId).padEnd(20)}  ${row.diffs}`
      );
    }
    if (ops.length > samplePreview.length) {
      console.log(`  ... 還有 ${ops.length - samplePreview.length} 筆未顯示`.gray);
    }
    console.log("─".repeat(96));

    if (!shouldApply) {
      console.log("\n[DRY-RUN] 未實際寫入。".cyan);
      console.log("[提示] 確認沒問題後，加 'apply' 參數實際寫入：".cyan);
      console.log("  node scripts/syncLegendarySwordDurability.js apply".white);
      return;
    }

    console.log(`\n[WARNING] 5 秒後寫入 ${ops.length} 筆更新，按 Ctrl+C 取消…`.yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const result = await collection.bulkWrite(ops, { ordered: false });
    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 完成：modified ${result.modifiedCount} 筆`.green);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`[ERROR] 遷移失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
