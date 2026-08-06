const { stockSystem } = require("../../config");

// /股市 的「股票代號」選項一律走 autocomplete 讀 DB。
// 原本用 addChoices 把 config 的 pool 烤進指令定義，下市換股後從 candidatePool
// 上市的新股永遠不會出現在下拉選單裡（也選得到已下市的舊股）。

const MAX_OPTIONS = 25;

function poolName(symbol) {
  const all = [...(stockSystem?.pool || []), ...(stockSystem?.candidatePool || [])];
  return all.find((p) => p.symbol === symbol)?.name || symbol;
}

function matches(query, symbol, name) {
  if (!query) return true;
  const q = query.toLowerCase();
  return symbol.toLowerCase().includes(q) || (name || "").toLowerCase().includes(q);
}

async function fetchStocks(client, guildId, includeDelisted) {
  const filter = { guildId };
  if (!includeDelisted) filter.enabled = { $ne: false };
  return client.stockMarketCollection.find(filter).sort({ symbol: 1 }).toArray();
}

function stockOption(stock) {
  const status =
    stock.enabled === false
      ? "已下市"
      : stock.listingStatus === "warning"
        ? "⚠️ 下市整理中"
        : null;
  const name = status
    ? `${stock.symbol} ${stock.name}｜${status}`
    : `${stock.symbol} ${stock.name}`;
  return { name, value: stock.symbol };
}

async function marketOptions(client, guildId, query, includeDelisted) {
  const stocks = await fetchStocks(client, guildId, includeDelisted);
  return stocks.filter((s) => matches(query, s.symbol, s.name)).map(stockOption);
}

// 持股 / 融券部位不存股票中文名，統一從現役股票表補；查無（極舊部位）才退回 config
async function nameMap(client, guildId) {
  const stocks = await fetchStocks(client, guildId, true);
  return new Map(stocks.map((s) => [s.symbol, s.name]));
}

async function positionOptions(client, interaction, query, { collection, unit }) {
  if (!collection) return [];
  const positions = await collection
    .find({ userId: interaction.user.id, guildId: interaction.guildId, shares: { $gt: 0 } })
    .sort({ symbol: 1 })
    .toArray();
  if (positions.length === 0) return [];

  const names = await nameMap(client, interaction.guildId);
  return positions
    .map((p) => ({ symbol: p.symbol, name: names.get(p.symbol) || poolName(p.symbol), shares: p.shares }))
    .filter((p) => matches(query, p.symbol, p.name))
    .map((p) => ({ name: `${p.symbol} ${p.name}｜${unit} ${p.shares} 股`, value: p.symbol }));
}

async function buildOptions(client, interaction, mode, query) {
  if (mode === "holding") {
    const owned = await positionOptions(client, interaction, query, {
      collection: client.userPortfolioCollection,
      unit: "持有",
    });
    // 沒有持股時仍列出全部，讓玩家選完後看到「你沒有持有 X」的明確錯誤，而不是空選單
    return owned.length > 0 ? owned : marketOptions(client, interaction.guildId, query, false);
  }
  if (mode === "short") {
    const shorted = await positionOptions(client, interaction, query, {
      collection: client.stockShortsCollection,
      unit: "融券",
    });
    return shorted.length > 0 ? shorted : marketOptions(client, interaction.guildId, query, false);
  }
  return marketOptions(client, interaction.guildId, query, mode === "all");
}

// mode：tradable（現役）/ all（含已下市，供查歷史）/ holding（自己的持股）/ short（自己的融券）
async function respondSymbolOptions(client, interaction, mode) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "股票代號" || !client.stockMarketCollection) {
    return interaction.respond([]).catch(() => {});
  }
  const options = await buildOptions(client, interaction, mode, (focused.value || "").trim());
  await interaction.respond(options.slice(0, MAX_OPTIONS)).catch(() => {});
}

module.exports = { respondSymbolOptions };
