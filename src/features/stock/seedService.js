const { stockSystem } = require("../../config");

// 把 config pool 裡「DB 尚未存在」的股票補進 StockMarket。
// 只針對已經有股市的 guild（distinct guildId），且用 $setOnInsert，
// 絕不覆寫現有股票的價格 / 狀態 → 可安全地每次開機執行。
async function backfillPoolStocks(client) {
  const pool = stockSystem?.pool || [];
  if (!client.stockMarketCollection || pool.length === 0) return { inserted: 0 };

  const guildIds = await client.stockMarketCollection.distinct("guildId");
  let inserted = 0;
  for (const guildId of guildIds) {
    const existing = await client.stockMarketCollection.findOne({ guildId });
    const sentiment =
      existing?.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways";
    for (const p of pool) {
      const res = await client.stockMarketCollection.updateOne(
        { guildId, symbol: p.symbol },
        {
          $setOnInsert: {
            guildId,
            symbol: p.symbol,
            name: p.name,
            currentPrice: p.initialPrice,
            openPrice: p.initialPrice,
            sigma: p.sigma,
            floor: p.floor,
            marketSentiment: sentiment,
            enabled: true,
            listedAt: new Date(),
          },
        },
        { upsert: true }
      );
      if (res.upsertedCount > 0) inserted += 1;
    }
  }
  return { inserted };
}

module.exports = { backfillPoolStocks };
