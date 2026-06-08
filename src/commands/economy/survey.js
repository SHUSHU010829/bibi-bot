require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { survey } = require("../../config");
const surveyService = require("../../features/survey/surveyService");
const {
  buildSurveyContainer,
  buildCompletedContainer,
  buildClosedContainer,
} = require("../../features/survey/surveyView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("問卷調查")
    .setDescription("填寫玩家問卷，完成全部必填題領 3000 幣 📋")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!survey?.enabled) {
        return interaction.editReply("🔧 問卷系統尚未啟動！");
      }
      if (!client.surveyResponsesCollection) {
        return interaction.editReply("🔧 問卷系統尚未啟動，請聯絡舒舒！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const existing = await surveyService.getResponse(client, userId, guildId);
      if (existing?.completedAt) {
        return interaction.editReply({
          components: [buildCompletedContainer(existing)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const window = surveyService.getWindowStatus();
      if (!window.open) {
        return interaction.editReply({
          components: [buildClosedContainer(window)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
      }

      const doc = await surveyService.ensureDoc(client, userId, guildId);

      return interaction.editReply({
        components: [buildSurveyContainer(userId, doc)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /問卷調查:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 問卷載入失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
