require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const {
  CATEGORIES,
  PERIODS,
  DEFAULT_CATEGORY,
} = require("../../features/leaderboard/categories");
const { renderLeaderboard } = require("../../features/leaderboard/render");

// 整合所有排行榜的單一入口：等級、訊息、語音、頻道、挖礦、賭場贏家／輸家。
// 進入後可以用下拉選單切換類別、按鈕切換時間區間，不用重打指令。
module.exports = {
  data: new SlashCommandBuilder()
    .setName("排行榜")
    .setDescription("查看伺服器各種排行榜 🏆")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) => {
      opt
        .setName("類別")
        .setDescription("要先打開哪個排行榜（預設等級）")
        .setRequired(false);
      for (const c of CATEGORIES) {
        opt.addChoices({ name: `${c.emoji} ${c.label}`, value: c.key });
      }
      return opt;
    })
    .addStringOption((opt) => {
      opt
        .setName("時間")
        .setDescription("統計時間區間（部分類別不適用，會自動採用該類別預設）")
        .setRequired(false);
      for (const [key, label] of Object.entries(PERIODS)) {
        opt.addChoices({ name: label, value: key });
      }
      return opt;
    }),

  run: async (client, interaction) => {
    const categoryKey =
      interaction.options.getString("類別") || DEFAULT_CATEGORY;
    const period = interaction.options.getString("時間");

    await interaction.deferReply();

    try {
      const payload = await renderLeaderboard(client, {
        categoryKey,
        period,
        interaction,
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /排行榜:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply({ content: "🔧 載入排行榜失敗，請呼叫舒舒！" })
        .catch(() => {});
    }
  },
};
