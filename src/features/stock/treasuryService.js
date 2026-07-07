const { DateTime } = require("luxon");
const { stockSystem } = require("../../config");

const TAX_SOURCES = ["stock_tax", "stock_daytrade_tax", "stock_div_tax"];

async function addToTreasury(client, guildId, amount) {
  if (!client.stockTreasuryCollection || !(amount > 0)) return null;
  const res = await client.stockTreasuryCollection.findOneAndUpdate(
    { guildId },
    {
      $inc: { balance: amount, lifetimeIn: amount },
      $set: { updatedAt: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );
  return res?.value || res;
}

async function getTreasury(client, guildId) {
  const empty = { guildId, balance: 0, lifetimeIn: 0, lifetimeOut: 0 };
  if (!client.stockTreasuryCollection) return empty;
  const doc = await client.stockTreasuryCollection.findOne({ guildId });
  return doc || empty;
}

// 從國庫支出，上限為現有餘額；回傳實際可支出額。
async function spendFromTreasury(client, guildId, amount) {
  if (!client.stockTreasuryCollection || !(amount > 0)) return 0;
  const cur = await getTreasury(client, guildId);
  const spend = Math.min(cur.balance || 0, Math.floor(amount));
  if (spend <= 0) return 0;
  await client.stockTreasuryCollection.updateOne(
    { guildId },
    {
      $inc: { balance: -spend, lifetimeOut: spend },
      $set: { updatedAt: new Date() },
    }
  );
  return spend;
}

// 今日三稅的進帳/銷毀彙總，以 CoinTransactions 為單一真相（稅金金額為負，取絕對值）。
async function getTodayTaxBreakdown(client, guildId) {
  const out = { sell: 0, dayTrade: 0, div: 0, total: 0, toTreasury: 0, burned: 0 };
  if (!client.coinTransactionsCollection) return out;
  const tz = stockSystem?.timezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();
  const rows = await client.coinTransactionsCollection
    .aggregate([
      { $match: { guildId, source: { $in: TAX_SOURCES }, date: today } },
      { $group: { _id: "$source", total: { $sum: "$amount" } } },
    ])
    .toArray();
  for (const r of rows) {
    const amt = Math.abs(r.total || 0);
    if (r._id === "stock_tax") out.sell = amt;
    else if (r._id === "stock_daytrade_tax") out.dayTrade = amt;
    else if (r._id === "stock_div_tax") out.div = amt;
  }
  out.total = out.sell + out.dayTrade + out.div;
  const share = stockSystem?.treasury?.treasuryShare ?? 0.5;
  out.toTreasury = Math.floor(out.total * share);
  out.burned = out.total - out.toTreasury;
  return out;
}

module.exports = {
  addToTreasury,
  getTreasury,
  spendFromTreasury,
  getTodayTaxBreakdown,
};
