require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");

const { DEFAULT_TAB } = require("../../features/profile/tabs");
const { renderTab } = require("../../features/profile/render");

// /檔案 是個人資料聚合入口：等級卡、礦工、錢包、賭場紀錄、成就 5 個分頁。
// 持股已獨立成 /股市 持股 子指令。
// 預設公開，可透過「私人」選項改為只有自己看得到。
// 切分頁的按鈕只限呼叫者本人點擊。
module.exports = {
  // 允許在一般 / 挖礦 / 股票三個頻道使用
  channelBuckets: ["general", "mining", "stock"],
  data: new SlashCommandBuilder()
    .setName("檔案")
    .setDescription("查看你的個人檔案：等級卡、礦工、錢包、賭場、成就 📇")
    .setContexts(InteractionContextType.Guild)
    .addBooleanOption((opt) =>
      opt
        .setName("私人")
        .setDescription("只有你看得到（預設公開）")
        .setRequired(false)
    ),

  run: async (client, interaction) => {
    const isPrivate = interaction.options.getBoolean("私人") ?? false;
    await interaction.deferReply({ ephemeral: isPrivate });

    try {
      const target = interaction.user;
      const member = interaction.member;

      const payload = await renderTab(client, {
        tabKey: DEFAULT_TAB,
        target,
        member,
        guildId: interaction.guildId,
      });

      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /檔案:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply({ content: "🔧 載入檔案失敗，請呼叫舒舒！" })
        .catch(() => {});
    }
  },
};
