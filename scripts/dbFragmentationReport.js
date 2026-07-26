require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 碎片量報告：判斷刪除 / 合併後「哪些 collection 值得 compact 回收磁碟」。
 *
 * 名詞：
 *   - dataSize    ：真實資料量（刪除後會下降）
 *   - storageSize ：資料檔實際佔用（刪除後幾乎不變，除非 compact）
 *   - 可回收     ：WiredTiger "file bytes available for reuse"，也就是 compact
 *                  能還給 OS 的空間；同 collection 之後的新寫入也會優先填這裡。
 *   - 碎片率     ：可回收 / storageSize
 *
 * 判讀：可回收位元組大（且佔比高）→ compact 才有感；小 → 不用白鎖表。
 *
 * 執行（伺服器主機上，用現成的 MONGO_URI）：
 *   node scripts/dbFragmentationReport.js
 */

const DB_NAME = "MorningBot";
const TOP_N = 20;
// 可回收超過這個門檻才建議 compact（避免為了幾 MB 白鎖表）
const COMPACT_SUGGEST_BYTES = 50 * 1024 * 1024;

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

  const colls = await db.listCollections().toArray();
  const rows = [];
  for (const c of colls) {
    try {
      const s = await db.command({ collStats: c.name });
      const reuse =
        s.wiredTiger?.["block-manager"]?.["file bytes available for reuse"] || 0;
      rows.push({
        name: c.name,
        count: s.count || 0,
        dataSize: s.size || 0,
        storage: s.storageSize || 0,
        reuse,
        indexSize: s.totalIndexSize || 0,
      });
    } catch (e) {
      console.log(`  [WARN] ${c.name}: ${e.message}`.yellow);
    }
  }

  const totalStorage = rows.reduce((s, r) => s + r.storage, 0);
  const totalReuse = rows.reduce((s, r) => s + r.reuse, 0);
  const totalIndex = rows.reduce((s, r) => s + r.indexSize, 0);

  console.log("\n=== 總覽 ===".cyan);
  console.log(`資料檔佔用（storageSize）: ${fmtMB(totalStorage)}`);
  console.log(`索引佔用              : ${fmtMB(totalIndex)}`);
  console.log(
    `可回收（碎片）        : ${fmtMB(totalReuse)}（${pct(totalReuse, totalStorage)}）` +
      `　← compact 能還給 OS 的上限`,
  );

  rows.sort((a, b) => b.reuse - a.reuse);

  console.log(`\n=== 各 collection 碎片（依可回收排序）Top ${TOP_N} ===`.cyan);
  console.log(
    "名稱".padEnd(34) +
      "資料".padEnd(12) +
      "佔用".padEnd(12) +
      "可回收".padEnd(12) +
      "碎片率".padEnd(9) +
      "文件數",
  );
  console.log("-".repeat(96));
  for (const r of rows.slice(0, TOP_N)) {
    const line =
      r.name.padEnd(34) +
      fmtMB(r.dataSize).padEnd(12) +
      fmtMB(r.storage).padEnd(12) +
      fmtMB(r.reuse).padEnd(12) +
      pct(r.reuse, r.storage).padEnd(9) +
      String(r.count);
    console.log(r.reuse >= COMPACT_SUGGEST_BYTES ? line.yellow : line);
  }

  const candidates = rows.filter((r) => r.reuse >= COMPACT_SUGGEST_BYTES);
  console.log(`\n=== 建議 ===`.green);
  if (candidates.length === 0) {
    console.log(
      `目前沒有 collection 可回收超過 ${fmtMB(COMPACT_SUGGEST_BYTES)}，` +
        `碎片會被後續寫入重用，不需 compact。`,
    );
  } else {
    console.log(`以下 collection 碎片較大，離峰時可考慮 compact 回收磁碟：`);
    for (const r of candidates) {
      console.log(`  • ${r.name}（可回收 ${fmtMB(r.reuse)}）`);
    }
    console.log(`\n指令（會短暫鎖住該 collection，挑離峰執行）：`.yellow);
    for (const r of candidates) {
      console.log(`  db.runCommand({ compact: "${r.name}" })`);
    }
    console.log(
      `\n註：Atlas 專屬叢集（M10+）支援 compact；共享層 / Serverless 不支援，`.gray,
    );
    console.log(`只能靠空間重用或升級方案。`.gray);
  }

  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.stack || e.message}`.red);
  process.exit(1);
});
