require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");
const mining = require("../src/config/mining.json");
const dungeon = require("../src/config/dungeon.json");
const fishing = require("../src/config/fishing.json");

/**
 * 把所有 MiningProfiles 的鎬子 / 武器 / 釣竿 *_max_durability 同步成 config 當前值，
 * 並把當前耐久 clamp 到新 max（避免大於 max）。
 *
 * 用途：調整 config 中工具的 durability 後，把舊有玩家的工具一次補成新值。
 *
 * 注意：劣質磨鎬石對 pickaxe_max_durability 的 -10 懲罰會被本次同步抹除。
 *
 * 執行：
 *   node scripts/syncToolMaxDurability.js          # dry-run，列出將被更動的玩家
 *   node scripts/syncToolMaxDurability.js apply    # 實際寫入
 */

const TOOLS = [
  {
    label: "鎬子",
    equippedField: "pickaxe",
    durabilityField: "pickaxe_durability",
    maxDurabilityField: "pickaxe_max_durability",
    defs: mining.mining?.pickaxes || mining.pickaxes || {},
    defaultId: "wood",
  },
  {
    label: "武器",
    equippedField: "weapon",
    durabilityField: "weapon_durability",
    maxDurabilityField: "weapon_max_durability",
    defs: dungeon.dungeon?.weapons || dungeon.weapons || {},
    defaultId: "fist",
  },
  {
    label: "釣竿",
    equippedField: "fishing_rod",
    durabilityField: "rod_durability",
    maxDurabilityField: "rod_max_durability",
    defs: fishing.fishing?.rods || fishing.rods || {},
    defaultId: "bamboo",
  },
];

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  for (const t of TOOLS) {
    if (Object.keys(t.defs).length === 0) {
      console.log(`[ERROR] 讀不到 ${t.label} 定義，請檢查 config 路徑`.red);
      process.exit(1);
    }
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const database = mongoClient.db("MorningBot");
    const collection = database.collection("MiningProfiles");

    const profiles = await collection
      .find(
        {},
        {
          projection: {
            userId: 1,
            guildId: 1,
            pickaxe: 1,
            pickaxe_durability: 1,
            pickaxe_max_durability: 1,
            weapon: 1,
            weapon_durability: 1,
            weapon_max_durability: 1,
            fishing_rod: 1,
            rod_durability: 1,
            rod_max_durability: 1,
          },
        }
      )
      .toArray();

    console.log(`[INFO] 掃描 ${profiles.length} 筆 MiningProfiles…`.cyan);

    const ops = [];
    const samplePreview = [];

    for (const p of profiles) {
      const set = {};
      const diffs = [];

      for (const t of TOOLS) {
        const equipped = p[t.equippedField];
        if (!equipped || equipped === t.defaultId) continue;

        const def = t.defs[equipped];
        if (!def || typeof def.durability !== "number") continue;

        const newMax = def.durability;
        const oldMax = p[t.maxDurabilityField];
        const cur = p[t.durabilityField];

        if (oldMax !== newMax) {
          set[t.maxDurabilityField] = newMax;
          diffs.push(`${t.label}(${equipped}) max ${oldMax ?? "—"}→${newMax}`);
        }
        // 當前耐久若超過新 max，clamp 下來
        if (typeof cur === "number" && cur > newMax) {
          set[t.durabilityField] = newMax;
          diffs.push(`${t.label}(${equipped}) cur ${cur}→${newMax}`);
        }
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
      console.log("  node scripts/syncToolMaxDurability.js apply".white);
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
