// 回填現有推薦紀錄的 Google Maps metadata。
//
// 預設只處理尚未抓過 metadata（缺 mapMetas 或為空）的紀錄；
// 加 --reanalyze 會在抓到 meta 後重新跑一次 AI 分類，把店名 / 地區
// 等欄位順便更新（會消耗 Anthropic API 額度）。
//
// AI 分類會把多筆塞進同一個 Claude 請求，預設一批 5 筆，
// 大幅減少 API 呼叫次數，遇到 Overloaded 時也比較容易撐過去。
//
// 用法範例：
//   # 先看會處理幾筆，不寫 DB
//   node src/scripts/backfillMapMeta.js --dry-run
//
//   # 抓 metadata，只更新 mapMetas 與缺少的 name
//   node src/scripts/backfillMapMeta.js
//
//   # 抓 metadata + 重跑 AI 分類（一批 5 筆）
//   node src/scripts/backfillMapMeta.js --reanalyze
//
//   # 把已有 mapMetas 的紀錄也一起重抓 + 一批 10 筆
//   node src/scripts/backfillMapMeta.js --force --reanalyze --batch=10

require("dotenv/config");
require("colors");

const { MongoClient } = require("mongodb");

const { fetchMapMetaForUrls } = require("../services/mapMetaFetcher");
const {
  analyzeRecommendationBatch,
} = require("../services/recommendationClassifier");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    reanalyze: false,
    force: false,
    limit: Infinity,
    delayMs: 300,
    batch: 3,
    batchDelayMs: 2000,
    help: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--reanalyze") args.reanalyze = true;
    else if (a === "--force") args.force = true;
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--delay=")) args.delayMs = parseInt(a.slice(8), 10);
    else if (a.startsWith("--batch=")) args.batch = parseInt(a.slice(8), 10);
    else if (a.startsWith("--batch-delay=")) {
      args.batchDelayMs = parseInt(a.slice(14), 10);
    } else if (a === "-h" || a === "--help") args.help = true;
  }
  if (!Number.isFinite(args.batch) || args.batch < 1) args.batch = 1;
  return args;
}

function printHelp() {
  console.log(`
回填現有推薦紀錄的 Google Maps metadata

用法：
  node src/scripts/backfillMapMeta.js [options]

選項：
  --dry-run           只統計，不寫入資料庫，也不抓 Google Maps
  --reanalyze         抓到 meta 後同時重新跑 AI 分類（會用 Anthropic API）
  --force             即使紀錄已有 mapMetas 也重抓
  --limit=N           最多處理 N 筆
  --delay=MS          每筆抓 Google Maps 後延遲毫秒數（預設 300）
  --batch=N           AI 分析的批次大小（預設 3；只在 --reanalyze 時有意義）
                      Batch 失敗時會自動 fallback 到單筆模式
  --batch-delay=MS    兩個 AI 批次之間延遲毫秒數（預設 2000）
  -h, --help          顯示此說明
`);
}

async function connectMongo() {
  if (!process.env.MONGO_URI) {
    throw new Error("缺少 MONGO_URI 環境變數");
  }
  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const collection = mongoClient.db("MorningBot").collection("Recommendations");
  return { mongoClient, collection };
}

function buildMetaUpdateSet(doc, metas, useAi) {
  const updateSet = {
    mapMetas: metas,
    mapMetaFetchedAt: new Date(),
    updatedAt: new Date(),
  };
  // 沒開 --reanalyze 時，name 為空就拿 placeName 補
  if (!useAi && metas.length > 0 && !doc.name && metas[0].placeName) {
    updateSet.name = metas[0].placeName.slice(0, 50);
  }
  return updateSet;
}

function mergeAnalysis(updateSet, analysis) {
  Object.assign(updateSet, {
    type: analysis.type,
    cuisine: analysis.cuisine,
    mealTimes: analysis.mealTimes,
    area: analysis.area,
    name: analysis.name,
    summary: analysis.summary,
    keywords: analysis.keywords,
  });
}

async function processBatch(collection, batch, stats, args) {
  if (batch.length === 0) return;

  // 整理成批次 AI 的輸入
  const items = batch
    .filter((b) => b.metas.length > 0)
    .map((b) => ({
      id: b.doc._id.toString(),
      rawText: b.doc.content || b.doc.cleanText || "",
      mapMetas: b.metas,
    }));

  let analyses = new Map();
  let sources = new Map();
  if (items.length > 0) {
    try {
      const result = await analyzeRecommendationBatch(items);
      analyses = result.analyses;
      sources = result.sources;
    } catch (error) {
      console.log(`\n[ERROR] 批次分析失敗：${error.message}`.red);
    }
  }

  for (const b of batch) {
    try {
      const updateSet = buildMetaUpdateSet(b.doc, b.metas, true);
      const id = b.doc._id.toString();
      const analysis = analyses.get(id);
      const source = sources.get(id);
      if (analysis) {
        mergeAnalysis(updateSet, analysis);
        if (source === "ai_batch") stats.aiBatch++;
        else if (source === "ai_single") stats.aiSingle++;
        else stats.heuristic++;
      }
      await collection.updateOne({ _id: b.doc._id }, { $set: updateSet });
      stats.updated++;
    } catch (error) {
      console.log(`\n[ERROR] ${b.doc.messageId}：${error.message}`.red);
    }
  }

  if (args.batchDelayMs > 0) {
    await new Promise((r) => setTimeout(r, args.batchDelayMs));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log("=== 推薦 Maps metadata 回填工具 ===".cyan);
  console.log(
    `模式：${args.dryRun ? "dry-run" : args.reanalyze ? `fetch + reanalyze (batch=${args.batch})` : "fetch only"}`,
  );
  console.log(
    `force=${args.force}　limit=${args.limit}　delay=${args.delayMs}ms　batch-delay=${args.batchDelayMs}ms`,
  );
  console.log("");

  const { mongoClient, collection } = await connectMongo();

  const baseQuery = { mapUrls: { $exists: true, $ne: [] } };
  if (!args.force) {
    baseQuery.$or = [
      { mapMetas: { $exists: false } },
      { mapMetas: { $size: 0 } },
      { mapMetas: null },
    ];
  }

  const total = await collection.countDocuments(baseQuery);
  console.log(`符合條件：${total} 筆`.cyan);

  if (total === 0 || args.dryRun) {
    if (args.dryRun) console.log("dry-run 結束，未寫入任何資料".yellow);
    await mongoClient.close();
    process.exit(0);
  }

  const cursorLimit = Number.isFinite(args.limit) ? args.limit : 0;
  const cursor = collection.find(baseQuery).limit(cursorLimit);

  const stats = {
    processed: 0,
    updated: 0,
    fetched: 0,
    empty: 0,
    aiBatch: 0,
    aiSingle: 0,
    heuristic: 0,
  };
  const t0 = Date.now();

  // 累積一個 batch，攢滿後丟給 AI 與 DB
  let batch = [];

  const flushProgress = () => {
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(
      `\r進度 ${stats.processed}/${total}　fetch ${stats.fetched}　無 meta ${stats.empty}　AI(batch/single) ${stats.aiBatch}/${stats.aiSingle}　啟發式 ${stats.heuristic}　${sec}s`,
    );
  };

  for await (const doc of cursor) {
    stats.processed++;
    try {
      const metas = await fetchMapMetaForUrls(doc.mapUrls, { delayMs: 0 });
      if (metas.length === 0) stats.empty++;
      else stats.fetched++;

      if (args.reanalyze) {
        batch.push({ doc, metas });
        if (batch.length >= args.batch) {
          await processBatch(collection, batch, stats, args);
          batch = [];
          flushProgress();
        }
      } else {
        const updateSet = buildMetaUpdateSet(doc, metas, false);
        await collection.updateOne({ _id: doc._id }, { $set: updateSet });
        stats.updated++;
      }
    } catch (error) {
      console.log(`\n[ERROR] ${doc.messageId}：${error.message}`.red);
    }

    if (args.delayMs > 0) {
      await new Promise((r) => setTimeout(r, args.delayMs));
    }
    if (stats.processed % 5 === 0 || stats.processed === total) {
      flushProgress();
    }
  }

  // 收尾：把剩下的 batch 處理掉
  if (batch.length > 0) {
    await processBatch(collection, batch, stats, args);
    batch = [];
    flushProgress();
  }
  process.stdout.write("\n");

  console.log("");
  console.log("=== 完成 ===".green);
  console.log(
    `處理：${stats.processed}　寫入：${stats.updated}　成功抓 meta：${stats.fetched}　無 meta：${stats.empty}`,
  );
  if (args.reanalyze) {
    const aiTotal = stats.aiBatch + stats.aiSingle;
    console.log(
      `AI batch：${stats.aiBatch}　AI single fallback：${stats.aiSingle}　啟發式 fallback：${stats.heuristic}　(AI 命中率 ${aiTotal}/${aiTotal + stats.heuristic})`,
    );
  }

  await mongoClient.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("回填失敗：".red, err);
  process.exit(1);
});
