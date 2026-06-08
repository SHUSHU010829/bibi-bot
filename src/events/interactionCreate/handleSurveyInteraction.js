require("colors");
const { MessageFlags } = require("discord.js");

const surveyService = require("../../features/survey/surveyService");
const {
  PREFIX,
  buildSurveyContainer,
  buildOpenModal,
  buildCompletedContainer,
  buildMissingContainer,
} = require("../../features/survey/surveyView");

function parseCustomId(customId) {
  if (!customId || !customId.startsWith(`${PREFIX}_`)) return null;
  const rest = customId.slice(PREFIX.length + 1);
  // 格式：<action>_<userId>[_<extra>]
  const parts = rest.split("_");
  if (parts.length < 2) return null;
  const action = parts[0];
  const userId = parts[1];
  const extra = parts.slice(2).join("_") || null;
  return { action, userId, extra };
}

module.exports = async (client, interaction) => {
  if (
    !interaction.isButton() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isModalSubmit?.()
  ) {
    return;
  }
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  const { action, userId: ownerId, extra } = parsed;

  if (interaction.user.id !== ownerId) {
    await interaction
      .reply({
        content: "這不是你的問卷！請自己用 `/問卷調查` 開一份。",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  if (!client.surveyResponsesCollection) {
    await interaction
      .reply({
        content: "🔧 問卷系統尚未啟動，請聯絡舒舒！",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const guildId = interaction.guildId;

  try {
    const existing = await surveyService.getResponse(client, ownerId, guildId);
    if (existing?.completedAt && action !== "noop") {
      // 已完成不允許再改
      await interaction
        .reply({
          components: [buildCompletedContainer(existing)],
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    if (action === "select" && interaction.isStringSelectMenu()) {
      const questionId = extra;
      await surveyService.saveSelectAnswer(
        client,
        ownerId,
        guildId,
        questionId,
        interaction.values,
      );
      const doc = await surveyService.getResponse(client, ownerId, guildId);
      await interaction.update({
        components: [buildSurveyContainer(ownerId, doc)],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === "open" && interaction.isButton()) {
      const doc = await surveyService.getResponse(client, ownerId, guildId);
      await interaction.showModal(buildOpenModal(ownerId, doc));
      return;
    }

    if (action === "modal" && interaction.isModalSubmit()) {
      const answers = {};
      for (const field of interaction.fields.fields.values()) {
        answers[field.customId] = field.value;
      }
      await surveyService.saveOpenAnswers(client, ownerId, guildId, answers);
      const doc = await surveyService.getResponse(client, ownerId, guildId);
      await interaction.update({
        components: [
          buildSurveyContainer(ownerId, doc, { hint: "自由意見已儲存，繼續填或直接送出。" }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === "submit" && interaction.isButton()) {
      await interaction.deferUpdate();
      const result = await surveyService.submit(
        client,
        ownerId,
        guildId,
        interaction.member,
        interaction.user.username,
      );

      if (!result.ok) {
        if (result.reason === "missing") {
          await interaction.editReply({
            components: [buildMissingContainer(result.missing)],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        if (result.reason === "already_completed") {
          await interaction.editReply({
            components: [buildCompletedContainer(result.doc)],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        await interaction.editReply({
          content: "🔧 送出失敗，請稍後再試或聯絡舒舒。",
          components: [],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      console.log(
        `[Survey] ${interaction.user.username} 完成問卷 +${result.reward} 幣`.cyan,
      );
      await interaction.editReply({
        components: [
          buildCompletedContainer(result.doc, { newBalance: result.newBalance }),
        ],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }
  } catch (error) {
    console.log(`[ERROR] survey interaction:\n${error}\n${error.stack}`.red);
    try {
      const payload = {
        content: "🔧 處理問卷時發生錯誤，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    } catch (_) {
      /* noop */
    }
  }
};
