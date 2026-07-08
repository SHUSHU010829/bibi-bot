require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, bank } = require("../../config");
const savingsService = require("../../features/bank/savingsService");
const { errorContainer, fmt } = require("../../features/bank/bankView");

function replyError(interaction, opts) {
  return interaction.editReply({
    components: [errorContainer(opts)],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("活存")
    .setDescription("活期存款：隨存隨取，每日自動計息 🏧")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("存入")
        .setDescription("把錢包金幣存進活期")
        .addIntegerOption((o) =>
          o.setName("金額").setDescription("存入金額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("提領")
        .setDescription("從活期把金幣領回錢包")
        .addIntegerOption((o) =>
          o.setName("金額").setDescription("提領金額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("查詢").setDescription("查看活期餘額與利率"))
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!coinSystem?.enabled) return interaction.editReply("🔧 金幣系統尚未啟動！");
      if (!bank?.savings?.enabled) return interaction.editReply("🔧 活期存款尚未開放。");
      if (!client.savingsAccountsCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 活期存款資料庫尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const avatarHash = interaction.user.avatar;
      const member = interaction.member;
      const sub = interaction.options.getSubcommand();
      const dailyRate = bank.savings.dailyRate || 0;
      const annual = (dailyRate * 365 * 100).toFixed(0);

      if (sub === "查詢") {
        const { balance } = await savingsService.view(client, userId, guildId);
        return interaction.editReply(
          `🏧 **活期存款**\n` +
            `・目前餘額：**${fmt(balance)}** credits\n` +
            `・利率：每日 ${(dailyRate * 100).toFixed(2)}%（年化約 ${annual}%）\n` +
            `-# 利息每次操作/查詢時自動結算入本金`,
        );
      }

      const amount = interaction.options.getInteger("金額");

      if (sub === "存入") {
        const res = await savingsService.deposit(client, {
          userId,
          guildId,
          username,
          member,
          avatarHash,
          amount,
        });
        if (!res.ok) {
          if (res.reason === "min") {
            return replyError(interaction, {
              title: "❌ 金額太小",
              detail: `活期單筆最少 **${fmt(res.minOp)}**，你輸入了 ${fmt(amount)}。`,
            });
          }
          if (res.reason === "cap") {
            return replyError(interaction, {
              title: "❌ 超過活期上限",
              detail: `活期餘額上限 **${fmt(res.maxBalance)}**，目前已有 ${fmt(res.curBalance)}。`,
              hint: "多的錢可考慮定存或黃金保值",
            });
          }
          if (res.reason === "wallet") {
            return replyError(interaction, {
              title: "💰 餘額不足",
              detail: `錢包只有 **${fmt(res.wallet)}**，無法存入 ${fmt(amount)}。`,
            });
          }
          return interaction.editReply("🔧 活期存入失敗，請稍後再試。");
        }
        return interaction.editReply(
          `✅ 已存入活期 **${fmt(res.amount)}** credits\n` +
            `・活期餘額：**${fmt(res.balance)}**（年化約 ${annual}%）\n` +
            `・錢包餘額：**${fmt(res.walletAfter)}**`,
        );
      }

      if (sub === "提領") {
        const res = await savingsService.withdraw(client, {
          userId,
          guildId,
          username,
          member,
          avatarHash,
          amount,
        });
        if (!res.ok) {
          if (res.reason === "balance") {
            return replyError(interaction, {
              title: "❌ 活期餘額不足",
              detail: `活期只有 **${fmt(res.balance)}**，無法提領 ${fmt(amount)}。`,
            });
          }
          return interaction.editReply("🔧 活期提領失敗，請稍後再試。");
        }
        return interaction.editReply(
          `✅ 已從活期領回 **${fmt(res.amount)}** credits\n` +
            `・活期餘額：**${fmt(res.balance)}**\n` +
            `・錢包餘額：**${fmt(res.walletAfter)}**`,
        );
      }
    } catch (error) {
      console.log(`[ERROR] /活存:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 活期存款指令執行失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
