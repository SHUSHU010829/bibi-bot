// 一次性：清掉 CoinTransactions 中 meta.game=crash 的最舊 N 筆 bet/payout 紀錄
// 用途：火箭調過 RTP 後想讓 /economy-dashboard 的賭場 Edge 從零開始計算
//
// 使用：node ./src/scripts/clearCrashStats.js [--limit=2000] [--dry-run]
//   --limit  刪幾筆，預設 2000；想全清傳 0
//   --dry-run 只印筆數不刪
//   排序：createdAt 升冪（先刪最舊）

require("dotenv").config();
require("colors");
const { MongoClient } = require("mongodb");

function parseLimit() {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return 2000;
  const n = Number(arg.split("=")[1]);
  if (!Number.isFinite(n) || n < 0) {
    console.log(`[ERROR] --limit 必須是非負整數`.red);
    process.exit(1);
  }
  return Math.floor(n);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const limit = parseLimit();

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數沒設".red);
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGO_URI);

  try {
    await client.connect();
    const coll = client.db("MorningBot").collection("CoinTransactions");

    const filter = { "meta.game": "crash" };
    const total = await coll.countDocuments(filter);
    console.log(`[INFO] meta.game=crash 共 ${total} 筆`.cyan);

    if (total === 0) {
      console.log("[INFO] 沒東西要清，結束".green);
      return;
    }

    const willDelete = limit === 0 ? total : Math.min(limit, total);
    console.log(
      `[INFO] 預計刪除最舊 ${willDelete} 筆（依 createdAt 升冪）`.cyan,
    );

    if (dryRun) {
      console.log("[DRY-RUN] 預覽結束，沒實際刪除".yellow);
      return;
    }

    let res;
    if (limit === 0) {
      res = await coll.deleteMany(filter);
    } else {
      const oldIds = await coll
        .find(filter, { projection: { _id: 1 } })
        .sort({ createdAt: 1 })
        .limit(limit)
        .toArray();
      const ids = oldIds.map((d) => d._id);
      res = await coll.deleteMany({ _id: { $in: ids } });
    }
    console.log(`[DONE] 刪除 ${res.deletedCount} 筆`.green);
  } catch (err) {
    console.log(`[ERROR] ${err.message}`.red);
    console.log(err.stack);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
