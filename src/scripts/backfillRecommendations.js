require("dotenv/config");
require("colors");

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { MongoClient } = require("mongodb");

const config = require("../config");
const {
  extractMapUrls,
  looksLikeRecommendation,
  stripUrls,
  heuristicAnalyze,
} = require("../utils/recommendationParser");
const {
  analyzeRecommendation,
} = require("../services/recommendationClassifier");

// CLI 參數解析（簡單版）
function parseArgs(argv) {
  const args = { dryRun: false, noAi: false, limit: Infinity, since: null };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-ai") args.noAi = true;
    else if (a.startsWith("--limit=")) args.limit = parseInt(a.slice(8), 10);
    else if (a.startsWith("--since=")) args.since = new Date(a.slice(8));
    else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
回填推薦頻道歷史訊息

用法：
  node src/scripts/backfillRecommendations.js [options]

選項：
  --dry-run        只統計，不寫入資料庫，也不呼叫 AI
  --no-ai          不呼叫 Claude，直接用啟發式分類（省 API 額度）
  --limit=N        最多處理 N 則訊息
  --since=YYYY-MM-DD  只處理該日期之後的訊息
  -h, --help       顯示此說明

範例：
  # 先看頻道有多少推薦訊息（不寫 DB、不打 AI）
  node src/scripts/backfillRecommendations.js --dry-run

  # 用啟發式跑完全部（之後可以用 /recommendation-admin reanalyze 修正）
  node src/scripts/backfillRecommendations.js --no-ai

  # 只回填 2025-01-01 以後的 200 則
  node src/scripts/backfillRecommendations.js --since=2025-01-01 --limit=200
`);
}

async function connectMongo() {
  if (!process.env.MONGO_URI) {
    throw new Error("缺少 MONGO_URI 環境變數");
  }
  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const collection = mongoClient.db("MorningBot").collection("Recommendations");
  await collection
    .createIndex({ messageId: 1 }, { unique: true, name: "uniq_rec_messageId" })
    .catch(() => {});
  return { mongoClient, collection };
}

async function fetchAllMessages(channel, { limit, since }) {
  // Discord API：一次最多 100 則。倒著抓（從最新往舊）。
  const all = [];
  let before = undefined;

  while (all.length < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    let stopByDate = false;
    for (const msg of batch.values()) {
      if (since && msg.createdAt < since) {
        stopByDate = true;
        break;
      }
      all.push(msg);
      if (all.length >= limit) break;
    }

    if (stopByDate || all.length >= limit) break;

    // 用 batch 的最舊一則當下一頁的 before
    before = batch.last().id;
    process.stdout.write(`\r已抓取 ${all.length} 則訊息...`);
    // 給 Discord rate limit 一點空間
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write("\n");
  return all;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const channelId = config.recommendation?.channelId;
  if (!channelId) {
    console.error("config.recommendation.channelId 未設定".red);
    process.exit(1);
  }
  if (!process.env.BOT_TOKEN) {
    console.error("缺少 BOT_TOKEN 環境變數".red);
    process.exit(1);
  }

  console.log("=== 推薦頻道回填工具 ===".cyan);
  console.log(`頻道：${channelId}`);
  console.log(`模式：${args.dryRun ? "dry-run" : args.noAi ? "啟發式" : "AI 分析"}`);
  if (args.since) console.log(`起始日期：${args.since.toISOString()}`);
  if (Number.isFinite(args.limit)) console.log(`筆數上限：${args.limit}`);
  console.log("");

  // Mongo（dry-run 也建連線，方便顯示「已存在」的計數）
  const { mongoClient, collection } = await connectMongo();

  // Discord login
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.login(process.env.BOT_TOKEN).catch(reject);
  });
  console.log(`已登入 Discord：${client.user.tag}`.green);

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) {
    console.error(`頻道 ${channelId} 不是文字頻道或無法存取`.red);
    await mongoClient.close();
    await client.destroy();
    process.exit(1);
  }

  console.log(`抓取訊息中...`.cyan);
  const messages = await fetchAllMessages(channel, {
    limit: args.limit,
    since: args.since,
  });
  console.log(`共抓到 ${messages.length} 則訊息`.cyan);

  // 過濾出像推薦的訊息
  const minTextLength = config.recommendation?.minTextLength ?? 2;
  const candidates = messages.filter(
    (m) => !m.author?.bot && looksLikeRecommendation(m.content || "", minTextLength),
  );
  console.log(`含 Google Maps 連結的候選：${candidates.length} 則`.cyan);

  if (args.dryRun) {
    // 同時統計：DB 已有幾則
    const ids = candidates.map((m) => m.id);
    const existing = await collection.countDocuments({
      messageId: { $in: ids },
    });
    console.log(`其中 ${existing} 則已在 DB；新進 ${candidates.length - existing} 則`.cyan);
    console.log("dry-run 結束，未寫入任何資料".yellow);
    await mongoClient.close();
    await client.destroy();
    process.exit(0);
  }

  // 真的回填
  let upserted = 0;
  let skipped = 0;
  let aiUsed = 0;
  let aiFailed = 0;
  const t0 = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const msg = candidates[i];
    try {
      const content = msg.content || "";
      const mapUrls = extractMapUrls(content);
      const cleanText = stripUrls(content);

      let analysis;
      if (args.noAi) {
        analysis = heuristicAnalyze(content);
      } else {
        const before = Date.now();
        analysis = await analyzeRecommendation(content);
        // 粗略判斷：若處理時間 < 50ms 通常是走 fallback，沒打 API
        if (Date.now() - before >= 200) aiUsed++;
        else aiFailed++;
      }

      const attachments = Array.from(msg.attachments?.values?.() || [])
        .map((a) => a.url)
        .filter(Boolean);

      const doc = {
        messageId: msg.id,
        channelId: msg.channel.id,
        guildId: msg.guild?.id || channel.guildId,
        authorId: msg.author.id,
        authorName: msg.author.username,
        authorTag: msg.author.tag || msg.author.username,
        content,
        cleanText,
        mapUrls,
        attachments,
        messageUrl: `https://discord.com/channels/${msg.guild?.id || channel.guildId}/${msg.channel.id}/${msg.id}`,
        type: analysis.type,
        cuisine: analysis.cuisine,
        mealTimes: analysis.mealTimes,
        area: analysis.area,
        name: analysis.name,
        summary: analysis.summary,
        keywords: analysis.keywords,
        createdAt: msg.createdAt || new Date(),
        updatedAt: new Date(),
        backfilledAt: new Date(),
      };

      const result = await collection.updateOne(
        { messageId: msg.id },
        { $set: doc },
        { upsert: true },
      );
      if (result.upsertedCount > 0) upserted++;
      else skipped++;

      if ((i + 1) % 20 === 0 || i === candidates.length - 1) {
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(
          `\r進度 ${i + 1}/${candidates.length}　新增 ${upserted}　已存在 ${skipped}　AI ${aiUsed}　fallback ${aiFailed}　耗時 ${sec}s`,
        );
      }
    } catch (error) {
      console.log(`\n[ERROR] 處理 ${msg.id} 失敗：${error.message}`.red);
    }
  }
  process.stdout.write("\n");

  console.log("");
  console.log("=== 完成 ===".green);
  console.log(`新增：${upserted}　已存在（更新）：${skipped}`);
  if (!args.noAi) {
    console.log(`AI 成功：${aiUsed}　降級啟發式：${aiFailed}`);
  }

  await mongoClient.close();
  await client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("回填失敗：".red, err);
  process.exit(1);
});
