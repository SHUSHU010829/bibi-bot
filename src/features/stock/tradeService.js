require("colors");
const { stockSystem } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../economy/grantCoins");
const portfolioService = require("./portfolioService");

function calcFee(amount) {
  const rate = stockSystem?.feeRate ?? 0.01;
  const minFee = stockSystem?.minFee ?? 5;
  return Math.max(minFee, Math.floor(amount * rate));
}

async function getMarketEntry(client, guildId, symbol) {
  if (!client.stockMarketCollection) return null;
  return client.stockMarketCollection.findOne({ guildId, symbol });
}

function isMarketOpen(now = new Date()) {
  // 簡單時段檢查：09:00–21:00 Taipei
  const tz = stockSystem?.timezone || "Asia/Taipei";
  const openHour = stockSystem?.marketOpenHour ?? 9;
  const closeHour = stockSystem?.marketCloseHour ?? 21;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
  });
  const h = parseInt(fmt.format(now), 10);
  // 21:00 整剛好是收盤，21:00:00–21:59:59 仍視為閉市
  return h >= openHour && h < closeHour;
}

async function buyMarket(client, opts) {
  const { userId, guildId, username, member, symbol, shares } = opts;
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: "invalid_shares", message: "❌ 買入股數需為正整數。" };
  }

  const market = await getMarketEntry(client, guildId, symbol);
  if (!market || market.enabled === false) {
    return { ok: false, reason: "no_symbol", message: `❌ 找不到股票代號 \`${symbol}\`。` };
  }

  const price = market.currentPrice;
  const totalCost = Math.floor(price * shares);
  const fee = calcFee(totalCost);
  const totalOut = totalCost + fee;

  // 餘額檢查
  const userCoins = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = userCoins?.totalCoins || 0;
  if (balance < totalOut) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: `${MONEY_EMOJI} 餘額不足！需要 **${totalOut.toLocaleString()}** credits（含手續費 ${fee.toLocaleString()}），目前 ${balance.toLocaleString()}。`,
    };
  }

  // 持股上限
  const maxShares = market.maxSharesPerUser ?? stockSystem?.maxSharesPerUser ?? 500;
  const existing = await portfolioService.getPosition(client, userId, guildId, symbol);
  const after = (existing?.shares || 0) + shares;
  if (after > maxShares) {
    return {
      ok: false,
      reason: "exceeds_max_shares",
      message: `🚫 超過單股持有上限（${maxShares} 股）。目前持有 ${existing?.shares || 0} 股。`,
    };
  }

  // 扣款：本金 + 手續費分兩筆
  const grantBuy = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -totalCost,
    source: "stock_buy",
    member,
    meta: { symbol, shares, price },
  });
  if (!grantBuy) {
    return { ok: false, reason: "grant_failed", message: "❌ 扣款失敗，請稍後再試。" };
  }
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "stock_fee",
    member,
    meta: { symbol, shares, side: "buy" },
  });

  // 更新持倉
  const newPos = await portfolioService.addPosition(client, userId, guildId, symbol, shares, price);

  // 紀錄交易
  await client.stockTransactionsCollection.insertOne({
    userId,
    guildId,
    symbol,
    side: "buy",
    shares,
    price,
    totalCost,
    fee,
    timestamp: new Date(),
  }).catch(() => {});

  return {
    ok: true,
    symbol,
    name: market.name,
    shares,
    price,
    totalCost,
    fee,
    totalOut,
    newShares: newPos.shares,
    newAvgCost: newPos.avgCost,
    balanceAfter: balance - totalOut,
  };
}

async function sellMarket(client, opts) {
  const { userId, guildId, username, member, symbol } = opts;
  let { shares } = opts;

  const market = await getMarketEntry(client, guildId, symbol);
  if (!market || market.enabled === false) {
    return { ok: false, reason: "no_symbol", message: `❌ 找不到股票代號 \`${symbol}\`。` };
  }

  const position = await portfolioService.getPosition(client, userId, guildId, symbol);
  if (!position || position.shares <= 0) {
    return { ok: false, reason: "no_position", message: `❌ 你沒有持有 \`${symbol}\`。` };
  }

  if (shares === "all" || shares === null || shares === undefined) {
    shares = position.shares;
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: "invalid_shares", message: "❌ 賣出股數需為正整數或 all。" };
  }
  if (shares > position.shares) {
    return {
      ok: false,
      reason: "exceeds_position",
      message: `❌ 持股不足！目前持有 ${position.shares} 股，無法賣 ${shares} 股。`,
    };
  }

  const price = market.currentPrice;
  const proceeds = Math.floor(price * shares);
  const fee = calcFee(proceeds);
  const netProceeds = proceeds - fee;
  const pnl = Math.floor((price - position.avgCost) * shares);

  // 收入：proceeds 全額走 stock_sell（正值），fee 另走 stock_fee（負值）
  // 這樣每日經濟報告 outflow 能完整看到 fee，stock_sell 顯示真實成交金額
  const grantSell = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: proceeds,
    source: "stock_sell",
    member,
    meta: { symbol, shares, price, pnl, avgCost: position.avgCost },
  });
  if (!grantSell) {
    return { ok: false, reason: "grant_failed", message: "❌ 入帳失敗，請稍後再試。" };
  }
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "stock_fee",
    member,
    meta: { symbol, shares, side: "sell" },
  });

  await portfolioService.reducePosition(client, userId, guildId, symbol, shares);

  await client.stockTransactionsCollection.insertOne({
    userId,
    guildId,
    symbol,
    side: "sell",
    shares,
    price,
    proceeds,
    fee,
    pnl,
    avgCost: position.avgCost,
    timestamp: new Date(),
  }).catch(() => {});

  const userCoins = await client.userCoinsCollection.findOne({ userId, guildId });
  return {
    ok: true,
    symbol,
    name: market.name,
    shares,
    price,
    proceeds,
    fee,
    netProceeds,
    pnl,
    avgCost: position.avgCost,
    remainingShares: position.shares - shares,
    balanceAfter: userCoins?.totalCoins || 0,
  };
}

module.exports = {
  buyMarket,
  sellMarket,
  calcFee,
  isMarketOpen,
  getMarketEntry,
};
