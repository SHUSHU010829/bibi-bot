// 打工 / 挖礦結果訊息下方「到點通知」開關按鈕處理器。
//
// 按鈕 customId = cdnotify_<type>_<ownerId>（見 features/reminders/cooldownReminderService.js）。
// 確認本人後切換訂閱狀態，就地刷新按鈕外觀，並 ephemeral 回覆目前狀態。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const reminder = require("../../features/reminders/cooldownReminderService");

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
    const parsed = reminder.parseCustomId(interaction.customId);
    if (!parsed) return;
    const { type, ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:cooldownNotify", {
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

    // 只有本人能操作自己結果訊息上的按鈕
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的通知按鈕，請呼叫自己的 /打工 或 /挖礦～"
      );
      return;
    }

    // 先確認互動，避免後續 DB 操作超過 3 秒 token 視窗
    await interaction.deferUpdate();

    const readyAt = await reminder.currentCooldownAt(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type,
    });

    const result = await reminder.toggle(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type,
      readyAt,
    });

    if (!result.ok) {
      await replyEphemeral(interaction, "🔧 通知功能暫時無法使用，請稍後再試。");
      return;
    }

    // 刷新訊息上的按鈕外觀（保留原本的 embed）
    const row = reminder.buildButtonRow({
      type,
      ownerId,
      enabled: result.enabled,
    });
    await interaction.editReply({ components: [row] });

    const meta = reminder.TYPE_META[type];
    if (result.enabled) {
      const note =
        readyAt > Date.now()
          ? `冷卻結束時（<t:${Math.floor(readyAt / 1000)}:R>）會私訊提醒你。`
          : "你現在就能行動囉，下次冷卻結束時會私訊提醒你。";
      await replyEphemeral(
        interaction,
        `🔔 已開啟${meta.label}到點通知！${note}\n` +
          "（提醒需要你對機器人開放私訊）"
      );
    } else {
      await replyEphemeral(interaction, `🔕 已關閉${meta.label}到點通知。`);
    }
    trackSuccess("cooldown-notify-toggle");
  } catch (err) {
    logger.error(
      {
        source: "cooldown-notify-toggle",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "切換到點通知時出錯"
    );
    trackError("cooldown-notify-toggle", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 切換通知失敗，請呼叫舒舒！");
  }
};
