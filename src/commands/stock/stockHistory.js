require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");

const { stockSystem } = require("../../config");
const { renderSingleLine } = require("../../features/stock/chartRenderer");

const PERIOD_MS = {
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("股歷")
    .setDescription("查詢單一股票的歷史走勢圖")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt.setName("股票代號").setDescription("例如 TSPP / UPPI / EGPP / CTPP / MTKP").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("期間")
        .setDescription("查詢期間（預設 1w）")
        .addChoices(
          { name: "近 24 小時", value: "1d" },
          { name: "近 7 天", value: "1w" },
          { name: "近 30 天", value: "1m" }
        )
        .setRequired(false)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
      if (!client.stockMarketCollection || !client.stockPricesCollection) {
        return interaction.editReply("🔧 股市系統尚未就緒。");
      }
      const guildId = interaction.guildId;
      const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
      const period = interaction.options.getString("期間") || "1w";
      const periodMs = PERIOD_MS[period] || PERIOD_MS["1w"];

      const market = await client.stockMarketCollection.findOne({ guildId, symbol });
      if (!market) return interaction.editReply(`❌ 找不到股票代號 \`${symbol}\`。`);

      const since = new Date(Date.now() - periodMs);
      const points = await client.stockPricesCollection
        .find({ guildId, symbol, timestamp: { $gte: since } })
        .sort({ timestamp: 1 })
        .toArray();

      if (points.length === 0) {
        return interaction.editReply(`📭 \`${symbol}\` 在所選期間內沒有歷史資料。`);
      }

      // 抽樣到最多 120 點，避免畫面過密
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
        title: `${symbol} ${market.name} ｜ ${period} 走勢（${sampled.length} 點）`,
      });
      const fileName = `stock_${symbol}.png`;
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
          new TextDisplayBuilder().setContent(
            `# 📜 ${symbol} ${market.name} 走勢`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**期間**\n${period}`),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**起 → 終**\n${first.toFixed(1)} → **${last.toFixed(1)}**（${sign}${pct.toFixed(2)}%）`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**高 / 低**\n${high.toFixed(1)} / ${low.toFixed(1)}`,
          ),
        )
        .addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder()
              .setURL(`attachment://${fileName}`)
              .setDescription(`${symbol} ${market.name} 走勢圖`),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
        files: [attachment],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      console.log(`[STOCK] /股歷 失敗：${err?.stack || err}`.red);
      await interaction.editReply("❌ 查詢失敗，請稍後再試。").catch(() => {});
    }
  },
};
