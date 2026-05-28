// 股價走勢圖容器:把走勢圖渲染成可直接 editReply 的 Components V2 Container + 附件。
// /股市 走勢、/股市 報價、/檔案 持股 都共用這個 builder。

const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  AttachmentBuilder,
} = require("discord.js");

const { renderSingleLine } = require("./chartRenderer");

const PERIOD_MS = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};
const PERIOD_LABEL = { "1d": "近 24 小時", "1w": "近 7 天", "1m": "近 30 天" };

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

  const MAX = 120;
  let sampled = points;
  if (points.length > MAX) {
    const step = Math.ceil(points.length / MAX);
    sampled = points.filter((_, i) => i % step === 0);
    if (sampled[sampled.length - 1] !== points[points.length - 1]) {
      sampled.push(points[points.length - 1]);
    }
  }

  const buf = renderSingleLine(symbol, market.name, sampled, {
    title: `${symbol} ${market.name} ｜ ${period} 走勢(${sampled.length} 點)`,
  });
  const fileName = `stock_${symbol}_${period}.png`;
  const attachment = new AttachmentBuilder(buf, { name: fileName });

  const prices = sampled.map((p) => p.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const first = prices[0];
  const last = prices[prices.length - 1];
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const sign = pct >= 0 ? "+" : "";

  const container = new ContainerBuilder()
    .setAccentColor(pct >= 0 ? 0x2ecc71 : 0xe74c3c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 📜 ${symbol} ${market.name} 走勢`)
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
    )
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${fileName}`)
          .setDescription(`${symbol} ${market.name} 走勢圖`)
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>`
      )
    );

  return { container, attachment };
}

module.exports = { buildChartContainer, PERIOD_MS, PERIOD_LABEL };
