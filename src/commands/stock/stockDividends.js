require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { stockSystem } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");

const PERIOD_MS = {
  "1m": 30 * 24 * 60 * 60 * 1000,
  "3m": 90 * 24 * 60 * 60 * 1000,
};

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("配息紀錄")
    .setDescription("查詢自己過去領到的股息明細")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("期間")
        .setDescription("查詢期間（預設 1m）")
        .addChoices(
          { name: "近 30 天", value: "1m" },
          { name: "近 90 天", value: "3m" }
        )
        .setRequired(false)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ ephemeral: true });
    try {
      if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
      if (!client.stockTransactionsCollection) {
        return interaction.editReply("🔧 股市系統尚未就緒。");
      }
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const period = interaction.options.getString("期間") || "1m";
      const periodMs = PERIOD_MS[period] || PERIOD_MS["1m"];
      const since = new Date(Date.now() - periodMs);

      const rows = await client.stockTransactionsCollection
        .find({
          userId,
          guildId,
          side: "dividend",
          timestamp: { $gte: since },
        })
        .sort({ timestamp: -1 })
        .toArray();

      if (rows.length === 0) {
        return interaction.editReply(`📭 你在所選期間內沒有配息紀錄。`);
      }

      const bySymbol = new Map();
      let grandTotal = 0;
      for (const r of rows) {
        let agg = bySymbol.get(r.symbol);
        if (!agg) {
          agg = { symbol: r.symbol, count: 0, total: 0, lastShares: r.shares, lastAt: r.timestamp };
          bySymbol.set(r.symbol, agg);
        }
        agg.count += 1;
        agg.total += r.payout || 0;
        grandTotal += r.payout || 0;
      }

      const symbols = [...bySymbol.keys()];
      let nameBySymbol = new Map();
      if (client.stockMarketCollection) {
        const markets = await client.stockMarketCollection
          .find({ guildId, symbol: { $in: symbols } })
          .toArray();
        nameBySymbol = new Map(markets.map((m) => [m.symbol, m.name]));
      }

      const summaryLines = [...bySymbol.values()]
        .sort((a, b) => b.total - a.total)
        .map((s) => {
          const name = nameBySymbol.get(s.symbol) || "";
          return `\`${s.symbol}\` ${name}　×${s.count} 次　**${s.total.toLocaleString()}** credits`;
        });

      const recentLines = rows.slice(0, 10).map((r) => {
        const ts = new Date(r.timestamp);
        const date = `${ts.getMonth() + 1}/${ts.getDate()}`;
        const name = nameBySymbol.get(r.symbol) || "";
        return `\`${date}\`　\`${r.symbol}\` ${name}　持股 ${r.shares}　+**${(r.payout || 0).toLocaleString()}**`;
      });

      const periodLabel = period === "3m" ? "近 90 天" : "近 30 天";

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${MONEY_EMOJI} ${interaction.member?.displayName || interaction.user.username} 的配息紀錄\n${summaryLines.join("\n")}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`**期間**\n${periodLabel}`),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**派息次數**\n${rows.length}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**合計入帳**\n**${grandTotal.toLocaleString()}** credits`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**最近明細**\n${recentLines.join("\n") || "—"}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 配息紀錄保留 90 天 ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.log(`[STOCK] /配息紀錄 失敗：${err?.stack || err}`.red);
      await interaction.editReply("❌ 查詢失敗，請稍後再試。").catch(() => {});
    }
  },
};
