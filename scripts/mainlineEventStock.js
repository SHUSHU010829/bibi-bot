require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");
const mining = require("../src/config/mining.json");

/**
 * 主線活動「全服共建」定總目標前的庫存盤點。
 *
 * 活動目標若拍腦袋定，只會有兩種結果：兩天被清空，或卡在最後 20% 拖一個月。
 * 這支腳本把「現在全服到底有多少鐵礦與逼幣」算出來，讓目標值有依據。
 *
 * 建議規則（見計畫書）：
 *   鐵礦目標 = 現有總庫存的 70–80%
 *   逼幣目標 = 總流通量的 8–12%
 * 兩者要落在相近的天數，否則會出現一邊三天滿格、一邊卡數週。
 *
 * 執行：
 *   node scripts/mainlineEventStock.js            # 預設看鐵礦
 *   node scripts/mainlineEventStock.js iron gold  # 指定要盤點的礦石
 */

const DB_NAME = "MorningBot";
const ACTIVE_DAYS = 14; // 與 boss.scaling.activeWithinDays 一致

const fmt = (n) => Math.round(n).toLocaleString();

function pctOf(total, lo, hi) {
  return `${fmt(total * lo)} ～ ${fmt(total * hi)}`;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定，請先放到 .env".red);
    process.exit(1);
  }
  const ores = process.argv.slice(2).filter((a) => mining.mining.ores[a]);
  const targets = ores.length ? ores : ["iron"];

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);

  const since = new Date(Date.now() - ACTIVE_DAYS * 86400000);
  const profiles = db.collection("MiningProfiles");

  const activeCount = await profiles.countDocuments({ updatedAt: { $gte: since } });
  const totalPlayers = await profiles.estimatedDocumentCount();

  console.log("\n=== 玩家規模 ===".cyan);
  console.log(`有挖礦檔案的玩家   : ${fmt(totalPlayers)}`);
  console.log(`近 ${ACTIVE_DAYS} 天活躍       : ${fmt(activeCount)}`);

  for (const ore of targets) {
    const def = mining.mining.ores[ore];
    console.log(`\n=== ${def.name}（${ore}）庫存 ===`.cyan);

    const [personal] = await profiles
      .aggregate([
        { $group: { _id: null, total: { $sum: `$backpack.${ore}` }, holders: { $sum: { $cond: [{ $gt: [`$backpack.${ore}`, 0] }, 1, 0] } } } },
      ])
      .toArray();

    const [personalActive] = await profiles
      .aggregate([
        { $match: { updatedAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: `$backpack.${ore}` } } },
      ])
      .toArray();

    const [guild] = await db
      .collection("GuildClubWarehouse")
      .aggregate([
        { $match: { item_id: ore } },
        { $group: { _id: null, total: { $sum: "$available_qty" } } },
      ])
      .toArray();

    const personalTotal = personal?.total || 0;
    const activeTotal = personalActive?.total || 0;
    const guildTotal = guild?.total || 0;
    const grand = personalTotal + guildTotal;

    console.log(`個人背包合計       : ${fmt(personalTotal)}（持有者 ${fmt(personal?.holders || 0)} 人）`);
    console.log(`  其中活躍玩家持有 : ${fmt(activeTotal)}`);
    console.log(`公會倉庫合計       : ${fmt(guildTotal)}`);
    console.log(`全服總庫存         : ${fmt(grand)}`.yellow);
    if (activeCount > 0) {
      console.log(`活躍玩家人均       : ${fmt(activeTotal / activeCount)}`);
    }
    console.log(`→ 建議目標（總量 70–80%）: ${pctOf(grand, 0.7, 0.8)}`.green);
    console.log(`-# 只算活躍玩家的話：${pctOf(activeTotal + guildTotal, 0.7, 0.8)}`.gray);
  }

  console.log("\n=== 逼幣流通量 ===".cyan);
  const coins = db.collection("UserCoins");
  const [coinAgg] = await coins
    .aggregate([{ $group: { _id: null, total: { $sum: "$coins" }, holders: { $sum: 1 } } }])
    .toArray();
  // 銀行定存的本金還沒回到錢包，但仍是玩家資產，要一起算進流通量
  const [bankAgg] = await db
    .collection("CoinDeposits")
    .aggregate([
      { $match: { status: "active" } },
      { $group: { _id: null, total: { $sum: "$principal" } } },
    ])
    .toArray();

  const wallet = coinAgg?.total || 0;
  const bank = bankAgg?.total || 0;
  console.log(`錢包合計           : ${fmt(wallet)}（${fmt(coinAgg?.holders || 0)} 人）`);
  console.log(`銀行定存本金       : ${fmt(bank)}`);
  console.log(`總流通量           : ${fmt(wallet + bank)}`.yellow);
  console.log(`→ 建議目標（8–12%）: ${pctOf(wallet + bank, 0.08, 0.12)}`.green);

  console.log("\n=== 節奏對照 ===".cyan);
  console.log("兩個目標要落在相近天數。以每人每日上限 鐵礦 200 / 逼幣 100,000 估：");
  if (activeCount > 0) {
    console.log(`  鐵礦：${fmt(activeCount * 200)} / 日（全員吃滿上限的理論值）`);
    console.log(`  逼幣：${fmt(activeCount * 100000)} / 日`);
    console.log("  實務上參與率抓 4–6 成、且囤貨清空後只剩產出，天數會拉長 2–3 倍。");
  }

  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.message}`.red);
  process.exit(1);
});
