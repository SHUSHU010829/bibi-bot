// /逼幣任務 介面下方「完成 DM 通知」開關按鈕處理器。
//
// 按鈕 customId = questnotify_<userId>（見 features/quests/questNotifyPref.js）。
// 確認本人後切換偏好，並就地重繪整個任務介面（含按鈕最新外觀）。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const questNotifyPref = require("../../features/quests/questNotifyPref");
const { buildQuestContainer } = require("../../features/quests/questView");

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const parsed = questNotifyPref.parseCustomId(interaction.customId);
    if (!parsed) return;
    const { userId: ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:questNotify", {
      windowMs: 2000,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`
      );
      return;
    }

    // 只有本人能操作自己 /逼幣任務 上的按鈕
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的任務面板，請呼叫自己的 /逼幣任務～"
      );
      return;
    }

    // 先確認互動，避免後續 DB 操作超過 3 秒 token 視窗
    await interaction.deferUpdate();

    const result = await questNotifyPref.toggle(
      client,
      interaction.user.id,
      interaction.guildId
    );
    if (!result.ok) {
      await replyEphemeral(interaction, "🔧 通知開關暫時無法使用，請稍後再試。");
      return;
    }

    // 就地重繪整個任務面板（含按鈕最新狀態）
    const container = await buildQuestContainer(
      client,
      interaction.user.id,
      interaction.guildId
    );
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    if (result.enabled) {
      await replyEphemeral(
        interaction,
        "🔔 已開啟任務完成 DM 通知！發言／語音／表情等被動任務完成時會私訊你。\n（私訊需要你對機器人開放 DM）"
      );
    } else {
      await replyEphemeral(
        interaction,
        "🔕 已關閉任務完成 DM 通知，被動任務將靜默自動入帳。"
      );
    }
    trackSuccess("quest-notify-toggle");
  } catch (err) {
    logger.error(
      {
        source: "quest-notify-toggle",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "切換任務通知時出錯"
    );
    trackError("quest-notify-toggle", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 切換通知失敗，請呼叫舒舒！");
  }
};
