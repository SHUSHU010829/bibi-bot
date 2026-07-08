require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, bank } = require("../../config");
const creditService = require("../../features/bank/creditService");
const goldService = require("../../features/bank/goldService");
const savingsService = require("../../features/bank/savingsService");
const loanService = require("../../features/bank/loanService");
const { COLOR, fmt, creditCard } = require("../../features/bank/bankView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("銀行")
    .setDescription("查看你的銀行總覽：信用分、活期、黃金、定存與貸款 🏦")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName("總覽").setDescription("一次看完錢包、信用分、活期、黃金、定存、貸款"),
    )
    .addSubcommand((sub) =>
      sub.setName("信用").setDescription("查看你的信用評等與各項銀行權益"),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const displayName = interaction.member?.displayName || interaction.user.username;
      const sub = interaction.options.getSubcommand();

      const limits = await creditService.getLimits(client, userId, guildId, interaction.member);

      if (sub === "信用") {
        return interaction.editReply({
          components: [creditCard(limits, displayName)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      // 總覽
      const [wallet, savings, goldPrices, goldHolding, activeDeposits, loans] =
        await Promise.all([
          client.userCoinsCollection.findOne({ userId, guildId }),
          bank?.savings?.enabled ? savingsService.view(client, userId, guildId) : null,
          bank?.gold?.enabled ? goldService.getPrices(client) : null,
          bank?.gold?.enabled ? goldService.getHolding(client, userId, guildId) : 0,
          client.coinDepositsCollection
            ? client.coinDepositsCollection.countDocuments({ userId, guildId, status: "active" })
            : 0,
          bank?.loan?.enabled && client.loansCollection
            ? loanService.listActive(client, userId, guildId)
            : [],
        ]);

      const balance = wallet?.totalCoins || 0;
      const unit = bank?.gold?.unitLabel || "克";
      const goldValue = goldPrices ? goldHolding * goldPrices.sell : 0;
      const loanOutstanding = (loans || []).reduce(
        (s, l) => s + (l.dueAmount - (l.paid || 0)),
        0,
      );

      const container = new ContainerBuilder()
        .setAccentColor(COLOR.gold)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🏦 ${displayName} 的銀行`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `💰 錢包餘額　**${fmt(balance)}**\n` +
              `${limits.tier.emoji} 信用評等　**${limits.tier.name}**（信用分 ${limits.score}）`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder());

      const lines = [];
      if (bank?.savings?.enabled) {
        lines.push(
          `🏧 活期存款　**${fmt(savings?.balance || 0)}**　-# 年化約 ${((bank.savings.dailyRate || 0) * 365 * 100).toFixed(0)}%`,
        );
      }
      if (bank?.gold?.enabled) {
        lines.push(
          `🪙 黃金金庫　**${fmt(goldHolding)}** ${unit}　≈ ${fmt(goldValue)} 幣　-# 賣出價 ${fmt(goldPrices.sell)}/${unit}`,
        );
      }
      lines.push(`📜 定期存款　**${activeDeposits}** 筆進行中`);
      if (bank?.loan?.enabled) {
        lines.push(
          loanOutstanding > 0
            ? `💳 貸款待還　**${fmt(loanOutstanding)}**`
            : `💳 貸款　無`,
        );
      }
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(lines.join("\n")),
      );

      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# /存款 定存　·　/活存 活期　·　/黃金 存摺　·　/貸款 借還　·　/轉帳 匯款",
          ),
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`bank_${userId}_credit`)
          .setLabel("信用分詳情")
          .setEmoji("📊")
          .setStyle(ButtonStyle.Primary),
      );
      if (loanOutstanding > 0 && loans[0]) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`bank_${userId}_loanrepay_${loans[0].loanId}`)
            .setLabel(`一鍵還清（${fmt(loanOutstanding)}）`)
            .setEmoji("💳")
            .setStyle(ButtonStyle.Success),
        );
      }
      container.addActionRowComponents(row);

      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /銀行:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 銀行查詢失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
