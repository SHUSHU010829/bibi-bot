require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");
const mining = require("../src/config/mining.json");
const dungeon = require("../src/config/dungeon.json");
const fishing = require("../src/config/fishing.json");

/**
 * 把 *_max_durability 從「原始上限 + 維修工具/磨石累積」的混合值拆成兩個欄位：
 *   *_max_durability       ← config 的原始上限
 *   *_max_durability_bonus ← 混合值 - 原始上限（維修工具 maxDelta 與劣質磨石 -10 的累計，可正可負）
 *
 * 拆出來的 bonus 之後不再被打造 / 購買覆蓋，所以傳說維修工具養出來的 +2 能跟著升級後的裝備走。
 *
 * ⚠️ 一定要在「調整 config 裡的 durability 數值之前」跑。
 *    拆分是拿 DB 值減掉 config 值，config 一改就分不出「哪些是配置改動、哪些是玩家累積的」。
 *    syncToolMaxDurability.js 會擋住未拆分的文件，就是為了這個順序。
 *
 * 沒跑這支也不會壞：normalize() 每次讀取都會在記憶體做同樣的拆分，
 * 下一次寫入（維修工具 / 磨石 / 打造）就會把拆分結果落盤。這支只是一次做完、可稽核。
 *
 * 執行：
 *   node scripts/splitEquipDurabilityBonus.js          # dry-run，列出將被拆出的 bonus
 *   node scripts/splitEquipDurabilityBonus.js apply    # 實際寫入
 */

const SLOTS = [
  {
    label: "鎬子",
    equippedField: "pickaxe",
    maxField: "pickaxe_max_durability",
    bonusField: "pickaxe_max_durability_bonus",
    defs: mining.mining?.pickaxes || mining.pickaxes || {},
    defaultId: "wood",
  },
  {
    label: "武器",
    equippedField: "weapon",
    maxField: "weapon_max_durability",
    bonusField: "weapon_max_durability_bonus",
    defs: dungeon.dungeon?.weapons || dungeon.weapons || {},
    defaultId: "fist",
  },
  {
    label: "盾牌",
    equippedField: "shield",
    maxField: "shield_max_durability",
    bonusField: "shield_max_durability_bonus",
    defs: dungeon.dungeon?.shields || dungeon.shields || {},
    defaultId: null,
  },
  {
    label: "釣竿",
    equippedField: "fishing_rod",
    maxField: "rod_max_durability",
    bonusField: "rod_max_durability_bonus",
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
  for (const s of SLOTS) {
    if (Object.keys(s.defs).length === 0) {
      console.log(`[ERROR] 讀不到 ${s.label} 定義，請檢查 config 路徑`.red);
      process.exit(1);
    }
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const collection = mongoClient.db("MorningBot").collection("MiningProfiles");

    const projection = { userId: 1, guildId: 1 };
    for (const s of SLOTS) {
      projection[s.equippedField] = 1;
      projection[s.maxField] = 1;
      projection[s.bonusField] = 1;
    }
    const profiles = await collection.find({}, { projection }).toArray();
    console.log(`[INFO] 掃描 ${profiles.length} 筆 MiningProfiles…`.cyan);

    const ops = [];
    const preview = [];
    const stats = { touched: 0, positive: 0, negative: 0, zero: 0 };

    for (const p of profiles) {
      const set = {};
      const diffs = [];

      for (const s of SLOTS) {
        // 已經有 bonus 欄位 = 拆過了，再減一次會把 bonus 吃掉
        if (typeof p[s.bonusField] === "number") continue;

        const equipped = p[s.equippedField];
        const mixed = p[s.maxField];

        // 沒裝備 / 沒上限的槽位沒有東西可拆，補 0 讓之後的讀寫都走同一條路
        if (!equipped || equipped === s.defaultId || typeof mixed !== "number") {
          set[s.bonusField] = 0;
          continue;
        }
        const base = s.defs[equipped]?.durability;
        if (typeof base !== "number") {
          set[s.bonusField] = 0;
          continue;
        }

        const bonus = mixed - base;
        set[s.bonusField] = bonus;
        if (bonus !== 0) {
          set[s.maxField] = base;
          diffs.push(`${s.label}(${equipped}) ${mixed} → base ${base} + bonus ${bonus > 0 ? "+" : ""}${bonus}`);
          if (bonus > 0) stats.positive++;
          else stats.negative++;
        } else {
          stats.zero++;
        }
      }

      if (Object.keys(set).length === 0) continue;
      stats.touched++;

      set.updatedAt = new Date();
      ops.push({
        updateOne: {
          filter: { userId: p.userId, guildId: p.guildId },
          update: { $set: set },
        },
      });
      if (diffs.length > 0 && preview.length < 30) {
        preview.push({ userId: p.userId, guildId: p.guildId, diffs: diffs.join(" / ") });
      }
    }

    console.log(
      `[INFO] 需寫入 ${stats.touched} 筆；其中拆出正 bonus ${stats.positive} 個槽位、負 bonus ${stats.negative} 個槽位、無累積 ${stats.zero} 個槽位`.cyan,
    );
    for (const row of preview) {
      console.log(`  - ${row.userId}@${row.guildId}: ${row.diffs}`.gray);
    }
    if (stats.positive + stats.negative > preview.length) {
      console.log(`  …（僅列出前 ${preview.length} 筆有差異的）`.gray);
    }

    if (!shouldApply) {
      console.log("[INFO] dry-run 結束，未寫入。加上 apply 參數才會實際更新。".yellow);
      return;
    }
    if (ops.length === 0) {
      console.log("[INFO] 沒有需要拆分的文件。".green);
      return;
    }

    const res = await collection.bulkWrite(ops, { ordered: false });
    console.log(`[SUCCESS] 已更新 ${res.modifiedCount} 筆。`.green);
  } catch (err) {
    console.log(`[ERROR] ${err}`.red);
    process.exitCode = 1;
  } finally {
    await mongoClient.close();
  }
}

main();
