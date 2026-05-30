require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const notifySettingsView = require("../../features/reminders/notifySettingsView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("通知設定")
    .setDescription("集中管理你的私訊提醒：總開關、挖礦／打工／火箭到點、任務完成 🔔")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const container = await notifySettingsView.buildContainer(
        client,
        interaction.user.id,
        interaction.guildId
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /通知設定:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 通知設定載入失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
