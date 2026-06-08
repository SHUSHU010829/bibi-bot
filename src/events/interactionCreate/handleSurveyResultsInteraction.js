require("colors");
const { MessageFlags } = require("discord.js");

const surveyService = require("../../features/survey/surveyService");
const {
  PREFIX,
  buildStatsContainer,
  buildOpenAnswersContainer,
} = require("../../features/survey/surveyResultsView");

function parseCustomId(customId) {
  if (!customId || !customId.startsWith(`${PREFIX}_`)) return null;
  const rest = customId.slice(PREFIX.length + 1);
  const parts = rest.split("_");
  if (parts.length < 2) return null;
  return {
    action: parts[0],
    userId: parts[1],
    extra: parts[2],
  };
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  const { action, userId: ownerId, extra } = parsed;

  if (interaction.user.id !== ownerId) {
    await interaction
      .reply({
        content: "這不是你的查詢面板！請自己用 `/survey-results` 開一份。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  try {
    await interaction.deferUpdate();

    const stats = await surveyService.aggregateStats(client, interaction.guildId);
    if (!stats) {
      await interaction.editReply({
        content: "🔧 找不到啟用中的問卷模板。",
        components: [],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "stats" || action === "refresh") {
      await interaction.editReply({
        components: [buildStatsContainer(stats, ownerId)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "open") {
      if (stats.openEntries.length === 0) {
        await interaction.editReply({
          components: [buildStatsContainer(stats, ownerId)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        });
        return;
      }
      const page = Number.parseInt(extra, 10) || 0;
      await interaction.editReply({
        components: [buildOpenAnswersContainer(stats, page, ownerId)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (error) {
    console.log(
      `[ERROR] survey-results interaction:\n${error}\n${error.stack}`.red,
    );
  }
};
