require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const surveyService = require("../../features/survey/surveyService");
const {
  buildStatsContainer,
} = require("../../features/survey/surveyResultsView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("survey-results")
    .setDescription("[ADMIN] 查看問卷統計與自由意見 📊")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.surveyResponsesCollection) {
        return interaction.editReply("🔧 問卷系統尚未啟動，請聯絡舒舒！");
      }

      const stats = await surveyService.aggregateStats(client, interaction.guildId);
      if (!stats) {
        return interaction.editReply("🔧 找不到啟用中的問卷模板。");
      }

      return interaction.editReply({
        components: [buildStatsContainer(stats, interaction.user.id)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /survey-results:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 統計載入失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
