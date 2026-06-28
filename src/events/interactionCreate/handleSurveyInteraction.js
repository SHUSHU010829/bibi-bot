require("colors");
const { MessageFlags } = require("discord.js");

const { deferUpdateSafe } = require("../../utils/safeAck");
const surveyService = require("../../features/survey/surveyService");
const {
  PREFIX,
  buildSurveyContainer,
  buildOpenModal,
  buildCompletedContainer,
  buildMissingContainer,
  buildClosedContainer,
  buildThankYouDm,
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

  // open 走 showModal，無法 defer（modal 必須是該互動的第一個回應）；其餘分支
  // 都會做 DB 查詢後才 update／editReply，先 deferUpdate 卡住 3 秒 ack 視窗。
  const isOpenModalBranch = action === "open" && interaction.isButton();

  try {
    if (!isOpenModalBranch) {
      if (!(await deferUpdateSafe(interaction))) return;
    }

    const existing = await surveyService.getResponse(client, ownerId, guildId);
    if (existing?.completedAt && action !== "noop") {
      // 已完成不允許再改。modal 分支未 defer，仍用 reply；其餘已 deferUpdate，用 followUp。
      const completedPayload = {
        components: [buildCompletedContainer(existing)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(completedPayload).catch(() => {});
      } else {
        await interaction.reply(completedPayload).catch(() => {});
      }
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
      await interaction.editReply({
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
      await interaction.editReply({
        components: [
          buildSurveyContainer(ownerId, doc, { hint: "自由意見已儲存，繼續填或直接送出。" }),
        ],
        flags: MessageFlags.IsComponentsV2,
      });
      return;
    }

    if (action === "submit" && interaction.isButton()) {
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
        if (result.reason === "closed") {
          await interaction.editReply({
            components: [buildClosedContainer(result.window)],
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

      // DM 感謝（玩家關閉 DM 就靜默略過，獎勵照發）
      let dmDelivered = true;
      try {
        await interaction.user.send({
          components: [buildThankYouDm(result.reward, result.newBalance)],
          flags: MessageFlags.IsComponentsV2,
        });
      } catch (dmErr) {
        dmDelivered = false;
        console.log(
          `[Survey] DM 失敗 ${interaction.user.username}: ${dmErr.message}`.yellow,
        );
      }

      await interaction.editReply({
        components: [
          buildCompletedContainer(result.doc, {
            newBalance: result.newBalance,
            dmDelivered,
          }),
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
