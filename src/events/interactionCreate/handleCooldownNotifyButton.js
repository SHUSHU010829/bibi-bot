// 【舊版相容】打工 / 挖礦結果訊息下方「到點通知」開關按鈕處理器。
//
// 通知開關已改由 /通知設定 集中管理，新的結果訊息不再附這顆按鈕；此處僅為了讓
// 改版前已發出、仍帶 cdnotify 按鈕的舊訊息能繼續運作。
//
// 注意：舊訊息是 Components V2 容器，過去直接 editReply({components:[row]}) 會把整個
// embed 洗掉（少了 IsComponentsV2 + 只剩一顆按鈕）。這裡改成「只切換訂閱 + ephemeral
// 回覆」，不再去動原訊息，從根本避開 embed 消失的問題。
//
// 按鈕 customId = cdnotify_<type>_<ownerId>（見 features/reminders/cooldownReminderService.js）。

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

    // 先確認互動（deferUpdate 不會更動原訊息），避免後續 DB 操作超過 3 秒 token 視窗。
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

    // 不再就地改寫原訊息（避免洗掉 V2 embed）；只用 ephemeral 回覆結果，並導引到新面板。
    const meta = reminder.TYPE_META[type];
    if (result.enabled) {
      const note =
        readyAt > Date.now()
          ? `冷卻結束時（<t:${Math.floor(readyAt / 1000)}:R>）會私訊提醒你。`
          : "你現在就能行動囉，下次冷卻結束時會私訊提醒你。";
      await replyEphemeral(
        interaction,
        `🔔 已開啟${meta.label}到點通知！${note}\n` +
          "（提醒需要你對機器人開放私訊；之後可用 `/通知設定` 集中管理通知）"
      );
    } else {
      await replyEphemeral(
        interaction,
        `🔕 已關閉${meta.label}到點通知。\n（之後可用 \`/通知設定\` 集中管理通知）`
      );
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
