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
const { checkServerTenure } = require("../../features/economy/eligibility");
const { buyMarket, isMarketOpen } = require("../../features/stock/tradeService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("買股")
    .setDescription("以市價買入股票")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt.setName("股票代號").setDescription("例如 TSPP / UPPI / EGPP / CTPP / MTKP").setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName("數量").setDescription("買入股數（正整數）").setRequired(true).setMinValue(1)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      if (!stockSystem?.enabled) return interaction.editReply("🔧 股市系統未啟用。");
      if (!client.stockMarketCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 股市系統尚未就緒。");
      }
      const tenure = checkServerTenure(interaction.member);
      if (!tenure.ok) return interaction.editReply(tenure.message);

      if (!isMarketOpen()) {
        return interaction.editReply("🌙 目前非開盤時間（09:00–21:00 Asia/Taipei）。");
      }

      const symbol = interaction.options.getString("股票代號").toUpperCase().trim();
      const shares = interaction.options.getInteger("數量");

      const result = await buyMarket(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.member?.displayName || interaction.user.username,
        member: interaction.member,
        symbol,
        shares,
      });

      if (!result.ok) return interaction.editReply(result.message);

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🟢 買入成交｜${result.symbol} ${result.name}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**成交價**\n**${result.price.toFixed(1)}** × ${result.shares} 股`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**本金**\n${result.totalCost.toLocaleString()}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**手續費**\n${result.fee.toLocaleString()}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**總扣款**\n**${result.totalOut.toLocaleString()}**`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**目前持有**\n${result.newShares} 股`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**平均成本**\n${result.newAvgCost.toFixed(2)}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**餘額**\n${result.balanceAfter.toLocaleString()}`,
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# <t:${Math.floor(Date.now() / 1000)}:R>`,
          ),
        );
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      console.log(`[STOCK] /買股 失敗：${err?.stack || err}`.red);
      await interaction.editReply("❌ 買入失敗，請稍後再試。").catch(() => {});
    }
  },
};
