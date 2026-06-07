require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const {
  queryHistory,
  buildContainer,
} = require("../../features/economy/coinHistory");
const { coinHistory } = require("../../config");

const CATEGORY_CHOICES = [
  { name: "全部來源", value: "all" },
  ...Object.entries(coinHistory?.categories || {}).map(([value, def]) => ({
    name: def.label.replace(/^[^ ]+ /, "") || value,
    value,
  })),
];

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("我的金流紀錄")
    .setDescription("🧾 查看完整的金幣入帳出帳紀錄（可按期間/方向/來源篩選）")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("期間")
        .setDescription("統計區間（預設：本月；紀錄保留 30 天）")
        .setRequired(false)
        .addChoices(
          { name: "今日", value: "today" },
          { name: "本週", value: "week" },
          { name: "本月", value: "month" },
          { name: "近 30 天（全部）", value: "all" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("方向")
        .setDescription("只看入帳或出帳（預設：全部）")
        .setRequired(false)
        .addChoices(
          { name: "全部", value: "all" },
          { name: "📥 只看入帳", value: "in" },
          { name: "📤 只看出帳", value: "out" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("來源")
        .setDescription("依來源分類篩選（預設：全部）")
        .setRequired(false)
        .addChoices(...CATEGORY_CHOICES.slice(0, 25)),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動。");
      }

      const filters = {
        period: interaction.options.getString("期間") || "month",
        direction: interaction.options.getString("方向") || "all",
        category: interaction.options.getString("來源") || "all",
      };

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const displayName =
        interaction.member?.displayName || interaction.user.username;

      const result = await queryHistory(client, {
        userId,
        guildId,
        ...filters,
        page: 0,
      });

      const container = buildContainer({
        result,
        filters,
        displayName,
        ownerId: userId,
      });

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /我的金流紀錄:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("❌ 查詢金流紀錄時發生錯誤，請稍後再試。")
        .catch(() => {});
    }
  },
};
