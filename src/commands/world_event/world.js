const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const worldEventService = require("../../features/world_event/worldEventService");
const worldEventView = require("../../features/world_event/worldEventView");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("世界事件")
    .setDescription("查看全伺服器共同目標與捐獻進度")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!worldEventService.isEnabled()) {
        return interaction.editReply({
          components: [
            worldEventView.buildSimpleError({
              title: "🔧 世界事件未啟用",
              body: "目前管理員未開啟此功能。",
            }),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      const events = await worldEventService.getActiveEvents(client);
      return interaction.editReply({
        components: [
          worldEventView.buildHomePanel({
            viewerId: interaction.user.id,
            events,
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (e) {
      console.log(`[WORLD_EVENT] /世界事件 失敗：${e.stack || e.message}`.red);
      return interaction.editReply({
        components: [
          worldEventView.buildSimpleError({
            title: "❌ 操作失敗",
            body: "出了點狀況，請稍後再試。",
          }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  },
};
