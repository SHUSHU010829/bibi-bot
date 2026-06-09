require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");
const { DateTime } = require("luxon");

const { stockSystem } = require("../../config");
const { nextPrice, calcMarketDrift } = require("../../features/stock/priceEngine");
const { rollRandomEvent } = require("../../features/stock/eventEngine");
const { isMarketOpen } = require("../../features/stock/tradeService");
const { renderMultiLine } = require("../../features/stock/chartRenderer");
const { getDailyVolume } = require("../../features/stock/volumeService");

const SENTIMENT_LABEL = {
  bull: "🐂 牛市",
  bear: "🐻 熊市",
  sideways: "🦀 震盪",
};

function pickWeightedSentiment(weights) {
  const entries = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0);
  if (entries.length === 0) return "sideways";
  const total = entries.reduce((s, [, w]) => s + Number(w), 0);
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    r -= Number(w);
    if (r <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

async function rotateSentimentOnce(client) {
  const cfg = stockSystem?.sentimentRotation;
  if (!cfg?.enabled) return { rotated: 0 };
  const guildIds = await listGuildIdsWithMarket(client);
  let rotated = 0;
  for (const guildId of guildIds) {
    const stocks = await client.stockMarketCollection
      .find({ guildId, enabled: { $ne: false } })
      .toArray();
    if (stocks.length === 0) continue;
    const prev = stocks[0]?.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways";
    const next = pickWeightedSentiment(cfg.weights);
    await client.stockMarketCollection.updateMany(
      { guildId, enabled: { $ne: false } },
      { $set: { marketSentiment: next, sentimentUpdatedAt: new Date() } }
    );
    if (cfg.announce !== false) {
      await announceSentimentChange(client, prev, next).catch((e) =>
        console.log(`[STOCK] sentiment announce failed guild=${guildId}: ${e?.message || e}`.yellow)
      );
    }
    if (prev !== next) rotated += 1;
  }
  return { rotated };
}

async function announceSentimentChange(client, prev, next) {
  const channelId = stockSystem?.announceChannelId || stockSystem?.broadcastChannelId || stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  if (prev === next) return;
  const color = next === "bull" ? 0x2ecc71 : next === "bear" ? 0xe74c3c : 0x95a5a6;
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🧭 市場情緒切換\n今日市場情緒：**${SENTIMENT_LABEL[next] || next}**（前日：${SENTIMENT_LABEL[prev] || prev}）`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );
  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

async function listGuildIdsWithMarket(client) {
  if (!client.stockMarketCollection) return [];
  return client.stockMarketCollection.distinct("guildId", { enabled: { $ne: false } });
}

async function tickOnce(client) {
  if (!isMarketOpen()) {
    return { ticked: 0, skipped: "market_closed" };
  }
  const guildIds = await listGuildIdsWithMarket(client);
  let ticked = 0;
  for (const guildId of guildIds) {
    const stocks = await client.stockMarketCollection
      .find({ guildId, enabled: { $ne: false } })
      .toArray();
    for (const s of stocks) {
      const drift = calcMarketDrift(s.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways");
      const next = nextPrice(s.currentPrice, s.sigma, drift, s.floor);
      await client.stockMarketCollection.updateOne(
        { _id: s._id },
        { $set: { currentPrice: next, updatedAt: new Date() } }
      );
      await client.stockPricesCollection.insertOne({
        guildId,
        symbol: s.symbol,
        price: next,
        timestamp: new Date(),
        source: "tick",
      }).catch(() => {});
      ticked += 1;
    }
    // 每個 guild 5% 機率觸發隨機事件
    await rollRandomEvent(client, guildId).catch((e) =>
      console.log(`[STOCK] rollRandomEvent failed guild=${guildId}: ${e?.message || e}`.yellow)
    );
    await postMarketBroadcast(client, guildId).catch((e) =>
      console.log(`[STOCK] broadcast failed guild=${guildId}: ${e?.message || e}`.yellow)
    );
  }
  return { ticked, guilds: guildIds.length };
}

async function postMarketBroadcast(client, guildId) {
  const channelId = stockSystem?.broadcastChannelId || stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const stocks = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false } })
    .sort({ symbol: 1 })
    .toArray();
  if (stocks.length === 0) return;

  const historyPoints = stockSystem?.chart?.historyPoints ?? 20;
  const tickMinutes = stockSystem?.tickIntervalMinutes ?? 5;
  const series = await Promise.all(
    stocks.map(async (s) => {
      const points = await client.stockPricesCollection
        .find({ guildId, symbol: s.symbol })
        .sort({ timestamp: -1 })
        .limit(historyPoints)
        .toArray();
      return { symbol: s.symbol, name: s.name, points: points.reverse() };
    })
  );

  const minutes = historyPoints * tickMinutes;
  const timeLabel =
    minutes >= 60
      ? `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)} 小時`
      : `${minutes} 分鐘`;
  const buf = renderMultiLine(series, {
    title: `逼逼股市｜最近 ${timeLabel}各股漲跌`,
  });
  const attachment = new AttachmentBuilder(buf, { name: "stock_market.png" });

  const sentiment = stocks[0]?.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways";
  const sentimentLabel = SENTIMENT_LABEL[sentiment] || sentiment;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const stockLines = [];
  for (const s of stocks) {
    const open = s.openPrice || s.currentPrice;
    const chg = open > 0 ? ((s.currentPrice - open) / open) * 100 : 0;
    const weekly = await client.stockPricesCollection
      .find({ guildId, symbol: s.symbol, timestamp: { $gte: weekAgo } })
      .toArray();
    const weekPrices = weekly.map((w) => w.price);
    const wh = weekPrices.length ? Math.max(...weekPrices, s.currentPrice) : s.currentPrice;
    const wl = weekPrices.length ? Math.min(...weekPrices, s.currentPrice) : s.currentPrice;

    let volLine = "";
    try {
      const vol = await getDailyVolume(client, { guildId, symbol: s.symbol });
      if (vol.totalShares > 0) {
        const net = vol.buyShares - vol.sellShares;
        const netLabel =
          net === 0 ? "持平" : net > 0 ? `🟢 淨買 +${net.toLocaleString()}` : `🔴 淨賣 ${net.toLocaleString()}`;
        volLine = `\n今日量 **${vol.totalShares.toLocaleString()}** 股　買 ${vol.buyShares.toLocaleString()} / 賣 ${vol.sellShares.toLocaleString()}　${netLabel}`;
      } else {
        volLine = `\n今日量 —`;
      }
    } catch (volErr) {
      console.log(`[STOCK] broadcast volume fetch failed (${s.symbol}): ${volErr.message}`.yellow);
    }

    stockLines.push(
      `**\`${s.symbol}\` ${s.name}**\n` +
        `現價 **${s.currentPrice.toFixed(1)}**　今日 ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%\n` +
        `週高 ${wh.toFixed(1)}　週低 ${wl.toFixed(1)}` +
        volLine,
    );
  }

  // 下次 tick 時間：對齊 tickIntervalMinutes
  const now = new Date();
  const mins = now.getMinutes();
  const nextTickMin = (Math.floor(mins / tickMinutes) + 1) * tickMinutes;
  const next = new Date(now);
  next.setMinutes(nextTickMin % 60, 0, 0);
  if (nextTickMin >= 60) next.setHours(next.getHours() + 1);
  const epoch = Math.floor(next.getTime() / 1000);

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📈 逼逼股市\n市場情緒：${sentimentLabel}　下次更新：<t:${epoch}:R>`,
      ),
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL("attachment://stock_market.png")
          .setDescription("市場走勢圖"),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(stockLines.join("\n\n")),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await channel
    .send({
      components: [container],
      files: [attachment],
      flags: MessageFlags.IsComponentsV2,
    })
    .catch((e) =>
      console.log(`[STOCK] broadcast send failed: ${e?.message || e}`.yellow),
    );
}

async function runOpen(client) {
  const guildIds = await listGuildIdsWithMarket(client);
  for (const guildId of guildIds) {
    // 把現價寫入今日 openPrice
    const stocks = await client.stockMarketCollection.find({ guildId, enabled: { $ne: false } }).toArray();
    for (const s of stocks) {
      await client.stockMarketCollection.updateOne(
        { _id: s._id },
        { $set: { openPrice: s.currentPrice, openedAt: new Date() } }
      );
    }
    await postOpenReport(client, guildId, stocks).catch(() => {});
  }
  return { guilds: guildIds.length };
}

async function postOpenReport(client, guildId, stocks) {
  const channelId = stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const lines = stocks.map(
    (s) => `\`${s.symbol}\` ${s.name}：開盤 **${(s.currentPrice).toFixed(1)}**`
  );
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🔔 逼逼股市｜今日開盤\n${lines.join("\n") || "（無上市股票）"}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );
  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

async function runClose(client) {
  const guildIds = await listGuildIdsWithMarket(client);
  for (const guildId of guildIds) {
    await postCloseReport(client, guildId).catch((e) =>
      console.log(`[STOCK] close report failed guild=${guildId}: ${e?.message || e}`.yellow)
    );
  }
  return { guilds: guildIds.length };
}

async function postCloseReport(client, guildId) {
  const channelId = stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const stocks = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false } })
    .toArray();
  const rows = stocks.map((s) => {
    const open = s.openPrice || s.currentPrice;
    const change = open > 0 ? ((s.currentPrice - open) / open) * 100 : 0;
    return {
      symbol: s.symbol,
      name: s.name,
      current: s.currentPrice,
      open,
      change,
    };
  });

  const sortedDesc = [...rows].sort((a, b) => b.change - a.change);
  const gainers = sortedDesc.slice(0, 3).filter((r) => r.change > 0);
  const losers = sortedDesc.slice(-3).reverse().filter((r) => r.change < 0);

  // 成交量統計（今日 stock_buy + stock_sell 筆數，依 symbol 分組）
  const today = DateTime.now().setZone(stockSystem?.timezone || "Asia/Taipei").toISODate();
  const startOfDay = DateTime.fromISO(today, { zone: stockSystem?.timezone || "Asia/Taipei" }).toJSDate();
  let topVolumeLine = "—";
  if (client.stockTransactionsCollection) {
    const volAgg = await client.stockTransactionsCollection
      .aggregate([
        { $match: { guildId, timestamp: { $gte: startOfDay } } },
        { $group: { _id: "$symbol", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ])
      .toArray();
    if (volAgg[0]) {
      topVolumeLine = `${volAgg[0]._id}（${volAgg[0].count} 筆）`;
    }
  }

  // 今日事件
  let eventLine = "（無）";
  if (client.stockEventsCollection) {
    const events = await client.stockEventsCollection
      .find({ guildId, timestamp: { $gte: startOfDay } })
      .sort({ timestamp: -1 })
      .limit(3)
      .toArray();
    if (events.length > 0) {
      eventLine = events
        .map((e) => `${e.name}（${e.effect >= 0 ? "+" : ""}${(e.effect * 100).toFixed(1)}%）`)
        .join("、");
    }
  }

  const fmtList = (list) =>
    list
      .map((r, i) => `${i + 1}. \`${r.symbol}\` ${r.change >= 0 ? "+" : ""}${r.change.toFixed(2)}%`)
      .join("\n") || "—";

  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# 📊 逼逼股市｜今日收盤報告",
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**漲幅榜**\n${fmtList(gainers)}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**跌幅榜**\n${fmtList(losers)}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**成交量最高**\n${topVolumeLine}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**今日事件**\n${eventLine}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

module.exports = async (client) => {
  if (!stockSystem?.enabled) {
    console.log(`[STOCK] 股市系統未啟用，跳過排程`.gray);
    return;
  }
  if (!client.stockMarketCollection) {
    console.log(`[STOCK] DB 未連線，跳過排程`.yellow);
    return;
  }

  const tz = stockSystem.timezone || "Asia/Taipei";

  registerCron(client, {
    name: "stock.tick",
    label: "股市價格 tick",
    schedule: stockSystem.tickCronSchedule || "*/5 * * * *",
    timezone: tz,
    runner: () => tickOnce(client),
  });

  registerCron(client, {
    name: "stock.open",
    label: "股市開盤",
    schedule: stockSystem.openCronSchedule || "0 9 * * *",
    timezone: tz,
    runner: () => runOpen(client),
  });

  registerCron(client, {
    name: "stock.close",
    label: "股市收盤",
    schedule: stockSystem.closeCronSchedule || "0 21 * * *",
    timezone: tz,
    runner: () => runClose(client),
  });

  const sentimentCfg = stockSystem.sentimentRotation;
  if (sentimentCfg?.enabled) {
    registerCron(client, {
      name: "stock.sentimentRotation",
      label: "股市情緒輪換",
      schedule: sentimentCfg.cronSchedule || "0 9 * * *",
      timezone: tz,
      runner: () => rotateSentimentOnce(client),
    });
  }
};

module.exports.tickOnce = tickOnce;
module.exports.runOpen = runOpen;
module.exports.runClose = runClose;
module.exports.postMarketBroadcast = postMarketBroadcast;
module.exports.rotateSentimentOnce = rotateSentimentOnce;
