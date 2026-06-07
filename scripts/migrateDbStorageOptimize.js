require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 一次性 DB 儲存空間優化遷移
 *
 * 1. 砍掉 LevelTransactions / CoinTransactions / CronJobLog 的舊 90d TTL 索引
 *    並重建為 30d 索引（與 connectDb.js 對齊）。
 * 2. 已結算 / 已放棄的 BlackjackGames doc 清掉 hands / dealerHand / playerHand / deck
 *    （結算後不再被任何查詢用到，純佔空間）。
 *
 * 執行：
 *   node scripts/migrateDbStorageOptimize.js          # dry-run，只印出將要做什麼
 *   node scripts/migrateDbStorageOptimize.js apply    # 實際執行
 */

const DB_NAME = "MorningBot";

const TTL_MIGRATIONS = [
  {
    collection: "LevelTransactions",
    oldName: "ttl_90d",
    newName: "level_tx_ttl_30d",
    key: { createdAt: 1 },
    expireAfterSeconds: 30 * 24 * 60 * 60,
  },
  {
    collection: "CoinTransactions",
    oldName: "coin_ttl_90d",
    newName: "coin_ttl_30d",
    key: { createdAt: 1 },
    expireAfterSeconds: 30 * 24 * 60 * 60,
  },
  {
    collection: "CronJobLog",
    oldName: "cron_log_ttl_90d",
    newName: "cron_log_ttl_30d",
    key: { startedAt: 1 },
    expireAfterSeconds: 30 * 24 * 60 * 60,
  },
];

async function migrateTtl(db, m, apply) {
  const col = db.collection(m.collection);
  const indexes = await col.indexes();
  const hasOld = indexes.some((i) => i.name === m.oldName);
  const hasNew = indexes.some((i) => i.name === m.newName);

  console.log(
    `\n[${m.collection}] old=${m.oldName} (${hasOld ? "exists" : "missing"}) new=${m.newName} (${hasNew ? "exists" : "missing"})`.cyan,
  );

  if (!apply) {
    if (hasOld) console.log(`  -> would dropIndex(${m.oldName})`.gray);
    if (!hasNew) console.log(`  -> would createIndex(${m.newName}, ${m.expireAfterSeconds}s)`.gray);
    return;
  }

  if (hasOld) {
    await col.dropIndex(m.oldName);
    console.log(`  ✓ dropped ${m.oldName}`.green);
  }
  if (!hasNew) {
    await col.createIndex(m.key, {
      expireAfterSeconds: m.expireAfterSeconds,
      name: m.newName,
    });
    console.log(`  ✓ created ${m.newName} (${m.expireAfterSeconds / 86400}d TTL)`.green);
  } else {
    console.log(`  - ${m.newName} 已存在，略過`.gray);
  }
}

async function compactBlackjack(db, apply) {
  const col = db.collection("BlackjackGames");
  const filter = {
    status: { $in: ["settled", "abandoned"] },
    $or: [
      { hands: { $exists: true } },
      { dealerHand: { $exists: true } },
      { playerHand: { $exists: true } },
      { deck: { $exists: true } },
    ],
  };

  const count = await col.countDocuments(filter);
  console.log(`\n[BlackjackGames] 已結算/放棄但仍存有牌型的 doc：${count}`.cyan);

  if (!apply) {
    console.log(`  -> would $unset hands/dealerHand/playerHand/deck on ${count} docs`.gray);
    return;
  }

  if (count === 0) {
    console.log(`  - 沒有需要清理的 doc`.gray);
    return;
  }

  const result = await col.updateMany(filter, {
    $unset: { hands: "", dealerHand: "", playerHand: "", deck: "" },
  });
  console.log(`  ✓ unset 完成，modified ${result.modifiedCount} docs`.green);
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定".red);
    process.exit(1);
  }
  const apply = process.argv.includes("apply");
  console.log(apply ? "=== APPLY 模式 ===".yellow : "=== DRY-RUN 模式（加上 apply 才會真的執行）===".gray);

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  for (const m of TTL_MIGRATIONS) {
    await migrateTtl(db, m, apply);
  }
  await compactBlackjack(db, apply);

  console.log("\n=== 完成 ===".green);
  console.log("提醒：縮短 TTL 後 mongod 的 TTL monitor 會在約 60 秒內掃過一次，");
  console.log("把超過 30 天的舊 doc 砍掉。Atlas 顯示的 Data Size 不會立刻下降，");
  console.log("等下一次 WiredTiger compact / 索引重建後才會反映實際儲存量。");

  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.stack || e.message}`.red);
  process.exit(1);
});
