// 股價走勢圖容器:把 K 線渲染成可直接 editReply 的 Components V2 Container + 附件。
// /股市 走勢、/股市 報價、/檔案 持股 都共用這個 builder。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  AttachmentBuilder,
} = require("discord.js");

const { stockSystem } = require("../../config");
const { renderCandles } = require("./chartRenderer");

const PERIOD_MS = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};
const PERIOD_LABEL = { "1d": "近 24 小時", "1w": "近 7 天", "1m": "近 30 天" };
const DEFAULT_CANDLE_MINUTES = { "1d": 15, "1w": 240, "1m": 1440 };

function candleMinutesFor(period) {
  const cfg = stockSystem?.chart?.candleMinutes || {};
  return cfg[period] || DEFAULT_CANDLE_MINUTES[period] || 60;
}

// 把逐 tick 價格點依 bucket 聚合成 K 棒（O=首、H=max、L=min、C=末），並把成交量分進同 bucket。
function buildCandles(points, trades, bucketMs, maxCount) {
  const map = new Map();
  for (const p of points) {
    const key = Math.floor(new Date(p.timestamp).getTime() / bucketMs) * bucketMs;
    let c = map.get(key);
    if (!c) {
      c = { t: key, open: p.price, high: p.price, low: p.price, close: p.price, buyShares: 0, sellShares: 0 };
      map.set(key, c);
    } else {
      c.high = Math.max(c.high, p.price);
      c.low = Math.min(c.low, p.price);
      c.close = p.price;
    }
  }
  for (const tr of trades) {
    const key = Math.floor(new Date(tr.timestamp).getTime() / bucketMs) * bucketMs;
    const c = map.get(key);
    if (!c) continue;
    if (tr.side === "buy") c.buyShares += tr.shares || 0;
    else if (tr.side === "sell") c.sellShares += tr.shares || 0;
  }
  const arr = [...map.values()].sort((a, b) => a.t - b.t);
  return arr.slice(-maxCount);
}

async function buildChartContainer(client, { guildId, symbol, period }) {
  const market = await client.stockMarketCollection.findOne({ guildId, symbol });
  if (!market) {
    return { container: null, attachment: `❌ 找不到股票代號 \`${symbol}\`。` };
  }

  const periodMs = PERIOD_MS[period] || PERIOD_MS["1w"];
  const since = new Date(Date.now() - periodMs);
  const points = await client.stockPricesCollection
    .find({ guildId, symbol, timestamp: { $gte: since } })
    .sort({ timestamp: 1 })
    .toArray();

  if (points.length === 0) {
    return {
      container: null,
      attachment: `📭 \`${symbol}\` 在所選期間內沒有歷史資料。`,
    };
  }

  const trades = await client.stockTransactionsCollection
    .find({ guildId, symbol, side: { $in: ["buy", "sell"] }, timestamp: { $gte: since } })
    .toArray()
    .catch(() => []);

  const bucketMs = candleMinutesFor(period) * 60 * 1000;
  const maxCount = stockSystem?.chart?.candleCount || 40;
  const candles = buildCandles(points, trades, bucketMs, maxCount);

  let attachment = null;
  let fileName = null;
  try {
    const buf = renderCandles(symbol, market.name, candles, {
      title: `${symbol} ${market.name}｜${period} K 線(${candles.length} 根)`,
    });
    fileName = `stock_${symbol}_${period}.png`;
    attachment = new AttachmentBuilder(buf, { name: fileName });
  } catch (chartErr) {
    console.log(
      `[WARN] stock candle render failed, falling back to text: ${chartErr.message}`
    );
  }

  const prices = points.map((p) => p.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const sign = pct >= 0 ? "+" : "";

  let buy = 0;
  let sell = 0;
  for (const tr of trades) {
    if (tr.side === "buy") buy += tr.shares || 0;
    else if (tr.side === "sell") sell += tr.shares || 0;
  }

  const container = new ContainerBuilder()
    .setAccentColor(pct >= 0 ? 0x2ecc71 : 0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📜 ${symbol} ${market.name} K 線`)
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**期間**\n${PERIOD_LABEL[period] || period}`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**起 → 終**\n${first.toFixed(1)} → **${last.toFixed(1)}**(${sign}${pct.toFixed(2)}%)`
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**高 / 低**\n${high.toFixed(1)} / ${low.toFixed(1)}`
      )
    );

  const total = buy + sell;
  if (total > 0) {
    const net = buy - sell;
    const netSign = net > 0 ? "+" : "";
    const netLabel = net === 0 ? "持平" : net > 0 ? "🟢 淨買超" : "🔴 淨賣超";
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**期間量**\n${total.toLocaleString()} 股 ・ 買 ${buy.toLocaleString()} / 賣 ${sell.toLocaleString()}\n${netLabel} ${netSign}${net.toLocaleString()}`
      )
    );
  }

  if (attachment) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${fileName}`)
          .setDescription(`${symbol} ${market.name} K 線`)
      )
    );
  } else {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `\`\`\`\n${buildAsciiSparkline(prices)}\n\`\`\``
        )
      );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# <t:${Math.floor(Date.now() / 1000)}:R>`
    )
  );

  return { container, attachment };
}

// 走勢圖生成失敗時用的 ASCII sparkline，把點壓縮到一行 8 格高度。
function buildAsciiSparkline(prices) {
  if (!prices.length) return "(無資料)";
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const WIDTH = 40;
  let sampled = prices;
  if (prices.length > WIDTH) {
    const step = prices.length / WIDTH;
    sampled = Array.from({ length: WIDTH }, (_, i) =>
      prices[Math.min(prices.length - 1, Math.floor(i * step))]
    );
  }
  return sampled
    .map((p) => {
      const idx = Math.round(((p - min) / range) * (blocks.length - 1));
      return blocks[Math.max(0, Math.min(blocks.length - 1, idx))];
    })
    .join("");
}

module.exports = { buildChartContainer, PERIOD_MS, PERIOD_LABEL };
