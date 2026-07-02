require("colors");
const { stockSystem } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../economy/grantCoins");
const { getMarketEntry, getLimitState, applyTradeImpact } = require("./tradeService");

// 融券做空：借股票在高點賣出，等跌了再低點回補賺價差。
// 採 100% 保證金（collateral = 開倉股數 × 開倉價），最大虧損以保證金為限；
// 當浮虧達保證金的 forceCloseLossPct 時由排程強制回補（斷頭）。

function shortCfg() {
  return stockSystem?.short || {};
}

function calcShortFee(amount) {
  const rate = shortCfg().feeRate ?? 0.01;
  const minFee = shortCfg().minFee ?? 5;
  return Math.max(minFee, Math.floor(amount * rate));
}

async function getShort(client, userId, guildId, symbol) {
  if (!client.stockShortsCollection) return null;
  return client.stockShortsCollection.findOne({ userId, guildId, symbol });
}

async function getAllShorts(client, userId, guildId) {
  if (!client.stockShortsCollection) return [];
  return client.stockShortsCollection
    .find({ userId, guildId, shares: { $gt: 0 } })
    .toArray();
}

// 未實現損益（做空：開倉價高於現價才賺）
function unrealizedShortPnl(position, currentPrice) {
  return Math.floor((position.avgShort - currentPrice) * position.shares);
}

async function openShort(client, opts) {
  const { userId, guildId, username, member, symbol, shares } = opts;
  if (!shortCfg().enabled) {
    return { ok: false, reason: "disabled", message: "🔧 融券做空未開放。" };
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: "invalid_shares", message: "❌ 融券股數需為正整數。" };
  }

  const market = await getMarketEntry(client, guildId, symbol);
  if (!market || market.enabled === false) {
    return { ok: false, reason: "no_symbol", message: `❌ 找不到股票代號 \`${symbol}\`。` };
  }

  // 做空＝賣壓，跌停時鎖住不能再放空
  const limit = getLimitState(market);
  if (limit.bounded && limit.atDown) {
    return {
      ok: false,
      reason: "limit_down",
      message: `💥 ${market.name}（\`${symbol}\`）已鎖跌停，暫時無法再放空。`,
    };
  }

  const price = market.currentPrice;
  const maxShares = shortCfg().maxShares ?? 300;
  const existing = await getShort(client, userId, guildId, symbol);
  const afterShares = (existing?.shares || 0) + shares;
  if (afterShares > maxShares) {
    return {
      ok: false,
      reason: "exceeds_max_shares",
      message: `🚫 超過單股融券上限（${maxShares} 股）。目前已放空 ${existing?.shares || 0} 股。`,
    };
  }

  const collateral = Math.floor(price * shares);
  const fee = calcShortFee(collateral);
  const totalOut = collateral + fee;

  const userCoins = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = userCoins?.totalCoins || 0;
  if (balance < totalOut) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: `${MONEY_EMOJI} 保證金不足！放空 ${shares} 股需凍結 **${collateral.toLocaleString()}**（含手續費 ${fee.toLocaleString()}），目前餘額 ${balance.toLocaleString()}。`,
    };
  }

  const grantMargin = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -collateral,
    source: "stock_short_margin",
    member,
    meta: { symbol, shares, price },
  });
  if (!grantMargin) {
    return { ok: false, reason: "grant_failed", message: "❌ 凍結保證金失敗，請稍後再試。" };
  }
  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -fee,
    source: "stock_fee",
    member,
    meta: { symbol, shares, side: "short_open" },
  });

  const oldShares = existing?.shares || 0;
  const oldAvg = existing?.avgShort || 0;
  const newShares = oldShares + shares;
  const newAvg = newShares > 0 ? (oldShares * oldAvg + shares * price) / newShares : price;
  const newCollateral = (existing?.collateral || 0) + collateral;

  await client.stockShortsCollection.updateOne(
    { userId, guildId, symbol },
    {
      $set: { shares: newShares, avgShort: newAvg, collateral: newCollateral, updatedAt: new Date() },
      $setOnInsert: { userId, guildId, symbol, createdAt: new Date() },
    },
    { upsert: true },
  );

  await client.stockTransactionsCollection.insertOne({
    userId,
    guildId,
    symbol,
    side: "short_open",
    shares,
    price,
    collateral,
    fee,
    timestamp: new Date(),
  }).catch(() => {});

  const impact = await applyTradeImpact(client, market, guildId, "sell", shares).catch(() => null);

  return {
    ok: true,
    symbol,
    name: market.name,
    shares,
    price,
    collateral,
    fee,
    totalOut,
    newShares,
    newAvgShort: newAvg,
    balanceAfter: balance - totalOut,
    impact,
  };
}

async function coverShort(client, opts) {
  const { userId, guildId, username, member, symbol, forced = false } = opts;
  let { shares } = opts;

  const market = await getMarketEntry(client, guildId, symbol);
  if (!market || market.enabled === false) {
    return { ok: false, reason: "no_symbol", message: `❌ 找不到股票代號 \`${symbol}\`。` };
  }

  const position = await getShort(client, userId, guildId, symbol);
  if (!position || position.shares <= 0) {
    return { ok: false, reason: "no_position", message: `❌ 你沒有 \`${symbol}\` 的融券部位。` };
  }

  // 回補＝買回，漲停時鎖住不能買回（強制斷頭除外）
  const limit = getLimitState(market);
  if (!forced && limit.bounded && limit.atUp) {
    return {
      ok: false,
      reason: "limit_up",
      message: `🚀 ${market.name}（\`${symbol}\`）已鎖漲停，暫時無法回補。`,
    };
  }

  if (shares === "all" || shares === null || shares === undefined) {
    shares = position.shares;
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { ok: false, reason: "invalid_shares", message: "❌ 回補股數需為正整數或 all。" };
  }
  if (shares > position.shares) {
    return {
      ok: false,
      reason: "exceeds_position",
      message: `❌ 融券部位不足！目前放空 ${position.shares} 股，無法回補 ${shares} 股。`,
    };
  }

  const coverPrice = market.currentPrice;
  const cost = Math.floor(coverPrice * shares);
  const fee = calcShortFee(cost);
  const pnl = Math.floor((position.avgShort - coverPrice) * shares); // 毛損益
  const collateralPortion = Math.floor(position.collateral * (shares / position.shares));
  // 結算入帳＝釋放的保證金 + 毛損益 − 手續費，下限 0（虧損以保證金為限）
  const settlement = Math.max(0, collateralPortion + pnl - fee);

  await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: settlement,
    source: "stock_short_settle",
    member,
    meta: { symbol, shares, coverPrice, avgShort: position.avgShort, pnl, fee, forced },
  });

  const remaining = position.shares - shares;
  if (remaining <= 0) {
    await client.stockShortsCollection.deleteOne({ userId, guildId, symbol });
  } else {
    await client.stockShortsCollection.updateOne(
      { userId, guildId, symbol },
      {
        $set: {
          shares: remaining,
          collateral: position.collateral - collateralPortion,
          updatedAt: new Date(),
        },
      },
    );
  }

  await client.stockTransactionsCollection.insertOne({
    userId,
    guildId,
    symbol,
    side: "short_cover",
    shares,
    price: coverPrice,
    proceeds: settlement,
    fee,
    pnl,
    avgShort: position.avgShort,
    forced,
    timestamp: new Date(),
  }).catch(() => {});

  const impact = await applyTradeImpact(client, market, guildId, "buy", shares).catch(() => null);

  const userCoins = await client.userCoinsCollection.findOne({ userId, guildId });
  return {
    ok: true,
    symbol,
    name: market.name,
    shares,
    coverPrice,
    avgShort: position.avgShort,
    pnl,
    fee,
    settlement,
    collateralReturned: collateralPortion,
    remainingShares: remaining,
    forced,
    balanceAfter: userCoins?.totalCoins || 0,
    impact,
  };
}

// 掃描所有融券部位，浮虧達保證金 forceCloseLossPct 者強制回補（斷頭）並私訊通知
async function runMarginScan(client) {
  if (!shortCfg().enabled) return { scanned: 0, forced: 0 };
  if (!client.stockShortsCollection || !client.stockMarketCollection) {
    return { scanned: 0, forced: 0 };
  }
  const lossPct = shortCfg().forceCloseLossPct ?? 0.8;
  const positions = await client.stockShortsCollection.find({ shares: { $gt: 0 } }).toArray();
  if (positions.length === 0) return { scanned: 0, forced: 0 };

  const marketCache = new Map();
  const getMarket = async (guildId, symbol) => {
    const key = `${guildId}|${symbol}`;
    if (!marketCache.has(key)) {
      marketCache.set(key, await client.stockMarketCollection.findOne({ guildId, symbol }));
    }
    return marketCache.get(key);
  };

  let forced = 0;
  for (const pos of positions) {
    const market = await getMarket(pos.guildId, pos.symbol);
    if (!market) continue;
    const loss = (market.currentPrice - pos.avgShort) * pos.shares; // 正值＝浮虧
    if (loss < pos.collateral * lossPct) continue;

    const result = await coverShort(client, {
      userId: pos.userId,
      guildId: pos.guildId,
      symbol: pos.symbol,
      shares: pos.shares,
      forced: true,
    }).catch((e) => {
      console.log(`[STOCK-SHORT] 斷頭失敗 user=${pos.userId} ${pos.symbol}: ${e?.message || e}`.yellow);
      return null;
    });
    if (!result?.ok) continue;
    forced += 1;

    // 斷頭後該股買回會影響價格，刷新快取避免同批其他人用到舊價
    marketCache.delete(`${pos.guildId}|${pos.symbol}`);

    try {
      const user = await client.users.fetch(pos.userId).catch(() => null);
      if (user) {
        await user.send(
          `⚠️ **${result.name}（${pos.symbol}）** 融券遭強制回補（斷頭）：` +
            `以 ${result.coverPrice.toLocaleString()} 買回 ${result.shares} 股，` +
            `保證金結算入帳 ${result.settlement.toLocaleString()}（毛損益 ${result.pnl >= 0 ? "+" : ""}${result.pnl.toLocaleString()}）。`,
        );
      }
    } catch (err) {
      console.log(`[STOCK-SHORT] 斷頭 DM 失敗 user=${pos.userId}: ${err?.message || err}`.yellow);
    }
  }
  return { scanned: positions.length, forced };
}

module.exports = {
  openShort,
  coverShort,
  getShort,
  getAllShorts,
  unrealizedShortPnl,
  runMarginScan,
  calcShortFee,
};
