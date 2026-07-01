require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");
const dungeon = require("../src/config/dungeon.json");

/**
 * 把所有玩家的 weapon_max_durability「回覆最原始的樣子」= config 武器 durability（原始上限）。
 *
 * 背景：公會鐵匠鋪的「武器耐久上限 +X%」以前是「打造 / 升級時把加成寫死進 weapon_max_durability」，
 * 導致 DB 存的是被灌高的值（base × (1+pct)），且離開公會也不會降回。
 * 改為「動態換算」後，DB 只存原始上限，加成由讀取端即時計算。
 * 本腳本把先前被腳本 / 升級灌上去的固定值統一清回原始 base，clamp 當前耐久到 base。
 *
 * 注意：
 *   - 只處理武器（加成僅作用於武器）；鎬子 / 釣竿的 *_max_durability 本就是 base，不動。
 *   - 劣質磨石對武器 max 的 -10 懲罰會被本次同步抹除（比照既有 syncToolMaxDurability 行為）。
 *   - 仍在公會、有鐵匠鋪加成的玩家：max 回到 base 後，有效上限仍由系統動態算回，
 *     修一次武器即補到含加成的上限。
 *
 * 執行：
 *   node scripts/resetWeaponMaxDurabilityToBase.js          # dry-run，列出將被更動的玩家
 *   node scripts/resetWeaponMaxDurabilityToBase.js apply     # 實際寫入
 */

const weaponDefs = dungeon.dungeon?.weapons || dungeon.weapons || {};

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  if (Object.keys(weaponDefs).length === 0) {
    console.log("[ERROR] 讀不到武器定義，請檢查 config 路徑".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const database = mongoClient.db("MorningBot");
    const collection = database.collection("MiningProfiles");

    const profiles = await collection
      .find(
        { weapon: { $nin: [null, "fist"] } },
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

    console.log(`[INFO] 掃描 ${profiles.length} 位持有武器的玩家…`.cyan);

    const ops = [];
    const samplePreview = [];

    for (const p of profiles) {
      const base = weaponDefs[p.weapon]?.durability;
      if (typeof base !== "number") continue;

      const set = {};
      const diffs = [];

      if (p.weapon_max_durability !== base) {
        set.weapon_max_durability = base;
        diffs.push(`max ${p.weapon_max_durability ?? "—"}→${base}`);
      }
      // 當前耐久超過原始 base 時 clamp（先前被灌高的固定耐久回到原始）。
      if (typeof p.weapon_durability === "number" && p.weapon_durability > base) {
        set.weapon_durability = base;
        diffs.push(`cur ${p.weapon_durability}→${base}`);
      }

      if (Object.keys(set).length === 0) continue;

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
          diffs: `${p.weapon}｜${diffs.join(" / ")}`,
        });
      }
    }

    if (ops.length === 0) {
      console.log("[INFO] 沒有任何玩家需要回覆，已是原始狀態。".cyan);
      return;
    }

    console.log(`\n[INFO] ${ops.length} 筆 profile 將被回覆原始（前 30 筆預覽）：`.yellow);
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
      console.log("  node scripts/resetWeaponMaxDurabilityToBase.js apply".white);
      return;
    }

    console.log(`\n[WARNING] 5 秒後寫入 ${ops.length} 筆更新，按 Ctrl+C 取消…`.yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const result = await collection.bulkWrite(ops, { ordered: false });
    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 完成：modified ${result.modifiedCount} 筆`.green);
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`[ERROR] 回覆失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
