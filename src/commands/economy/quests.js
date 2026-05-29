require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { questSystem } = require("../../config");
const { buildQuestContainer } = require("../../features/quests/questView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("逼幣任務")
    .setDescription("查看每日／週常任務進度 📜")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!questSystem?.enabled) {
        return interaction.editReply("🔧 任務系統尚未啟動！");
      }
      if (!client.questProgressCollection) {
        return interaction.editReply("🔧 任務系統尚未啟動，請聯絡舒舒！");
      }

      const container = await buildQuestContainer(
        client,
        interaction.user.id,
        interaction.guildId
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /逼幣任務:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 任務查詢失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
