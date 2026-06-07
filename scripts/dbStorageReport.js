require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

const DB_NAME = "MorningBot";
const TOP_N = 10;

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pct(part, total) {
  if (!total) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定，請先放到 .env".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  const dbStats = await db.stats();
  console.log("\n=== DB 總覽 ===".cyan);
  console.log(`資料量    : ${fmtMB(dbStats.dataSize)}`);
  console.log(`儲存佔用  : ${fmtMB(dbStats.storageSize)} (壓縮後實際佔用)`);
  console.log(`索引佔用  : ${fmtMB(dbStats.indexSize)}`);
  console.log(`總實際佔用: ${fmtMB(dbStats.storageSize + dbStats.indexSize)}`);
  console.log(`collection 數: ${dbStats.collections}`);

  const colls = await db.listCollections().toArray();
  const rows = [];
  for (const c of colls) {
    try {
      const s = await db.command({ collStats: c.name });
      rows.push({
        name: c.name,
        count: s.count || 0,
        storage: s.storageSize || 0,
        indexSize: s.totalIndexSize || 0,
        total: (s.storageSize || 0) + (s.totalIndexSize || 0),
        avgObj: s.avgObjSize || 0,
        nindexes: s.nindexes || 0,
      });
    } catch (e) {
      console.log(`  [WARN] ${c.name}: ${e.message}`.yellow);
    }
  }

  rows.sort((a, b) => b.total - a.total);
  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  console.log(`\n=== Top ${TOP_N} 兇手（資料 + 索引）===`.cyan);
  console.log(
    "名稱".padEnd(34) +
      "資料".padEnd(13) +
      "索引".padEnd(13) +
      "合計".padEnd(13) +
      "占比".padEnd(8) +
      "文件數".padEnd(12) +
      "平均大小".padEnd(12) +
      "#idx",
  );
  console.log("-".repeat(110));
  for (const r of rows.slice(0, TOP_N)) {
    console.log(
      r.name.padEnd(34) +
        fmtMB(r.storage).padEnd(13) +
        fmtMB(r.indexSize).padEnd(13) +
        fmtMB(r.total).padEnd(13) +
        pct(r.total, grandTotal).padEnd(8) +
        String(r.count).padEnd(12) +
        `${Math.round(r.avgObj)} B`.padEnd(12) +
        String(r.nindexes),
    );
  }

  console.log(`\n=== 索引佔用 Top ${TOP_N} ===`.cyan);
  const byIdx = [...rows].sort((a, b) => b.indexSize - a.indexSize).slice(0, TOP_N);
  for (const r of byIdx) {
    console.log(
      `${r.name.padEnd(34)} ${fmtMB(r.indexSize).padEnd(13)} (${r.nindexes} idx)`,
    );
  }

  console.log(`\n=== 未使用 / 低使用率索引（候選刪除）===`.cyan);
  console.log("（_id_ 為主索引不可刪；ops 是 server 啟動以來累計使用次數）\n");
  for (const r of rows.slice(0, TOP_N)) {
    try {
      const stats = await db
        .collection(r.name)
        .aggregate([{ $indexStats: {} }])
        .toArray();
      const idle = stats.filter(
        (s) => s.name !== "_id_" && (s.accesses?.ops || 0) === 0,
      );
      if (idle.length === 0) continue;
      console.log(`[${r.name}]`.yellow);
      for (const s of idle) {
        console.log(`  - ${s.name}  (ops=0, since ${s.accesses?.since || "?"})`);
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`\n=== 建議 ===`.green);
  const top3 = rows.slice(0, 3).map((r) => r.name);
  console.log(`1. 優先處理: ${top3.join(", ")}`);
  console.log(`2. 索引最肥: ${byIdx[0].name} (${fmtMB(byIdx[0].indexSize)})`);
  console.log(`3. 文件數最多: ${[...rows].sort((a, b) => b.count - a.count)[0].name}`);
  console.log(`4. 上面列出的 ops=0 索引可以考慮 dropIndex`);

  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.stack || e.message}`.red);
  process.exit(1);
});
