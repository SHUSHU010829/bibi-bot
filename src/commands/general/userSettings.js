require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const userSettingsView = require("../../features/settings/userSettingsView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("個人設定")
    .setDescription("管理 dashboard 公開頁面顯示等個人偏好 ⚙️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const container = await userSettingsView.buildContainer(
        client,
        interaction.user.id,
        interaction.guildId,
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /個人設定:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 個人設定載入失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
