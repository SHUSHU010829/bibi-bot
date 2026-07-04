require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { stockSystem } = require("../../config");
const portfolioService = require("./portfolioService");
const tradeService = require("./tradeService");

// 停損 / 停利距現價要保留的最小百分比距離（避免抖動立刻觸發）
const MIN_GAP_PCT = 0.01;

async function setTriggers(client, { userId, guildId, symbol, stopLoss, takeProfit }) {
  if (!client.userPortfolioCollection || !client.stockMarketCollection) {
    return { ok: false, reason: "disabled" };
  }
  const position = await portfolioService.getPosition(client, userId, guildId, symbol);
  if (!position || position.shares <= 0) {
    return { ok: false, reason: "no_position" };
  }
  const market = await client.stockMarketCollection.findOne({ guildId, symbol });
  if (!market || market.enabled === false) {
    return { ok: false, reason: "no_symbol" };
  }
  const price = market.currentPrice;

  const cleanStop = stopLoss === null || stopLoss === undefined ? null : Number(stopLoss);
  const cleanTake = takeProfit === null || takeProfit === undefined ? null : Number(takeProfit);

  if (cleanStop != null) {
    if (!Number.isFinite(cleanStop) || cleanStop <= 0) {
      return { ok: false, reason: "bad_stop_loss" };
    }
    if (cleanStop >= price * (1 - MIN_GAP_PCT)) {
      return { ok: false, reason: "stop_too_close", currentPrice: price };
    }
  }
  if (cleanTake != null) {
    if (!Number.isFinite(cleanTake) || cleanTake <= 0) {
      return { ok: false, reason: "bad_take_profit" };
    }
    if (cleanTake <= price * (1 + MIN_GAP_PCT)) {
      return { ok: false, reason: "take_too_close", currentPrice: price };
    }
  }

  await client.userPortfolioCollection.updateOne(
    { userId, guildId, symbol },
    {
      $set: {
        stopLoss: cleanStop,
        takeProfit: cleanTake,
        limitLockNotified: false,
        updatedAt: new Date(),
      },
    },
  );

  return {
    ok: true,
    symbol,
    currentPrice: price,
    stopLoss: cleanStop,
    takeProfit: cleanTake,
    name: market.name,
  };
}

async function clearTriggers(client, { userId, guildId, symbol }) {
  if (!client.userPortfolioCollection) return { ok: false, reason: "disabled" };
  await client.userPortfolioCollection.updateOne(
    { userId, guildId, symbol },
    { $set: { stopLoss: null, takeProfit: null, limitLockNotified: false, updatedAt: new Date() } },
  );
  return { ok: true };
}

// 同一組觸發設定只自動成交 1 次，避免極端波動連續刷洗。
// 只擋「這組觸發設定生效後」才發生的自動成交（configuredAt = 觸發設定/持倉最後更新時間）；
// 玩家事後買回並重設觸發（updatedAt 會往後跳），屬於全新設定，不受舊成交紀錄影響。
async function recentlyTriggered(client, { userId, guildId, symbol, configuredAt }) {
  if (!client.stockTransactionsCollection) return false;
  // 沒有設定時間可比對就不擋（設定觸發時一定寫入 updatedAt，理論上不會落到這）
  if (!configuredAt) return false;
  const doc = await client.stockTransactionsCollection.findOne({
    userId,
    guildId,
    symbol,
    side: "sell",
    timestamp: { $gte: configuredAt },
    "meta.autoTrigger": { $exists: true },
  });
  return !!doc;
}

// 取得受監視的部位列表（任一觸發欄位非 null）
async function listWatched(client) {
  if (!client.userPortfolioCollection) return [];
  return client.userPortfolioCollection
    .find({
      shares: { $gt: 0 },
      $or: [
        { stopLoss: { $ne: null, $exists: true } },
        { takeProfit: { $ne: null, $exists: true } },
      ],
    })
    .toArray();
}

// 鎖跌停導致停損 / 停利暫時無法成交時，只私訊玩家一次（用 limitLockNotified 去重）。
// updateOne 的 { $ne: true } 條件保證即使 in-memory position 讀到舊值，也只有一次成功翻旗 → 只發一封。
async function notifyLimitLockedOnce(client, position, market, kind, price) {
  const { userId, guildId, symbol } = position;
  const res = await client.userPortfolioCollection
    .updateOne(
      { userId, guildId, symbol, limitLockNotified: { $ne: true } },
      { $set: { limitLockNotified: true } },
    )
    .catch(() => null);
  if (!res || res.modifiedCount !== 1) return;

  try {
    const user = await client.users.fetch(userId);
    const verb = kind === "stop_loss" ? "停損" : "停利";
    const container = new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# ⚠️ ${verb}暫時無法成交\n**${market.name}（${symbol}）** 已觸及你的${verb}價 **${price.toLocaleString()}**`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `目前該股**鎖跌停**，暫時無法成交。\n系統會持續監看，一旦解鎖就立即自動全倉賣出並再通知你。`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 觸價時間 <t:${Math.floor(Date.now() / 1000)}:R>`),
      );
    await user.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (err) {
    console.log(`[stock.trigger] 跌停通知 DM 失敗 user=${userId}: ${err?.message || err}`.yellow);
  }
}

// 對單一部位判斷是否命中觸發條件；命中即執行 sellMarket 並通知玩家
async function evaluateAndTrigger(client, position, marketBySymbol) {
  const { userId, guildId, symbol, shares, stopLoss, takeProfit } = position;
  const market = marketBySymbol.get(symbol);
  if (!market || market.enabled === false) return null;
  const price = market.currentPrice;

  let kind = null;
  if (stopLoss != null && price <= stopLoss) kind = "stop_loss";
  else if (takeProfit != null && price >= takeProfit) kind = "take_profit";
  if (!kind) return null;

  const configuredAt = position.updatedAt || position.createdAt || null;
  if (await recentlyTriggered(client, { userId, guildId, symbol, configuredAt })) {
    return null;
  }

  const username = position.username || "";
  const result = await tradeService.sellMarket(client, {
    userId,
    guildId,
    username,
    member: null,
    symbol,
    shares,
  });
  if (!result.ok) {
    // 鎖跌停賣不掉：保留觸發設定、每分鐘持續重試，解鎖那刻即成交；只在第一次鎖住時私訊一次
    if (result.reason === "limit_down") {
      await notifyLimitLockedOnce(client, position, market, kind, price);
    } else {
      console.log(
        `[stock.trigger] 自動${kind === "stop_loss" ? "停損" : "停利"}賣出失敗 user=${userId} ${symbol}@${price}: ${result.reason || "unknown"}`.yellow,
      );
    }
    return null;
  }

  await client.stockTransactionsCollection
    .updateOne(
      { userId, guildId, symbol, side: "sell", timestamp: { $exists: true } },
      { $set: { "meta.autoTrigger": kind, "meta.triggerPrice": price } },
      { sort: { timestamp: -1 } },
    )
    .catch(() => {});

  await client.userPortfolioCollection
    .updateOne({ userId, guildId, symbol }, { $set: { stopLoss: null, takeProfit: null } })
    .catch(() => {});

  try {
    const user = await client.users.fetch(userId);
    const verb = kind === "stop_loss" ? "停損" : "停利";
    const unlockedNote = position.limitLockNotified ? "（跌停解鎖後成交）" : "";
    const pnlSign = result.pnl >= 0 ? "+" : "";
    const container = new ContainerBuilder()
      .setAccentColor(kind === "stop_loss" ? 0xe74c3c : 0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🔔 觸發${verb}自動賣出${unlockedNote}\n**${market.name}（${symbol}）**`,
        ),
      )
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `成交價　**${price.toLocaleString()}**\n` +
            `賣出　**${shares.toLocaleString()}** 股\n` +
            `成交額　${result.proceeds.toLocaleString()}（淨 **${result.netProceeds.toLocaleString()}**）\n` +
            `盈虧　**${pnlSign}${result.pnl.toLocaleString()}**`,
        ),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# <t:${Math.floor(Date.now() / 1000)}:R>`),
      );
    await user.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch (err) {
    console.log(`[stock.trigger] DM 失敗 user=${userId}: ${err?.message || err}`.yellow);
  }

  return { userId, guildId, symbol, kind, price, result };
}

async function runScan(client) {
  if (!stockSystem?.enabled) return { scanned: 0, triggered: 0 };
  if (!tradeService.isMarketOpen()) return { scanned: 0, triggered: 0 };

  const positions = await listWatched(client);
  if (positions.length === 0) return { scanned: 0, triggered: 0 };

  const guildSymbols = new Map();
  for (const p of positions) {
    if (!guildSymbols.has(p.guildId)) guildSymbols.set(p.guildId, new Set());
    guildSymbols.get(p.guildId).add(p.symbol);
  }

  const marketBySymbol = new Map();
  for (const [guildId, symbols] of guildSymbols.entries()) {
    const docs = await client.stockMarketCollection
      .find({ guildId, symbol: { $in: [...symbols] } })
      .toArray();
    for (const m of docs) marketBySymbol.set(m.symbol, m);
  }

  let triggered = 0;
  for (const position of positions) {
    const hit = await evaluateAndTrigger(client, position, marketBySymbol).catch((err) => {
      console.log(`[stock.trigger] eval err: ${err?.stack || err}`.red);
      return null;
    });
    if (hit) triggered++;
  }
  return { scanned: positions.length, triggered };
}

module.exports = {
  setTriggers,
  clearTriggers,
  runScan,
  MIN_GAP_PCT,
};
