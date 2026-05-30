// /通知設定 面板按鈕處理器。
//
// 按鈕 customId = notifyset_<action>_<userId>（見 features/reminders/notifySettingsView.js）。
// 確認本人後切換對應偏好，並就地重繪整個面板（含所有按鈕最新外觀）。
//   - master           → 通知總開關（notifyPrefs）
//   - mining/work/crash → 到點通知（cooldownReminderService，依當前冷卻設定 readyAt）
//   - quest            → 任務完成 DM（questNotifyPref）

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const reminder = require("../../features/reminders/cooldownReminderService");
const notifyPrefs = require("../../features/reminders/notifyPrefs");
const notifySettingsView = require("../../features/reminders/notifySettingsView");
const questNotifyPref = require("../../features/quests/questNotifyPref");

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
    const parsed = notifySettingsView.parseCustomId(interaction.customId);
    if (!parsed) return;
    const { action, userId: ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:notifySettings", {
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

    // 只有本人能操作自己的 /通知設定 面板
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的通知設定面板，請呼叫自己的 /通知設定～"
      );
      return;
    }

    // 先確認互動，避免後續 DB 操作超過 3 秒 token 視窗
    await interaction.deferUpdate();

    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    let note = null;

    if (action === "master") {
      const result = await notifyPrefs.toggleMaster(client, userId, guildId);
      if (!result.ok) {
        await replyEphemeral(interaction, "🔧 通知功能暫時無法使用，請稍後再試。");
        return;
      }
      note = result.enabled
        ? "🔔 已開啟通知總開關，下面個別開著的提醒都會恢復。"
        : "🔕 已關閉通知總開關，所有提醒都會靜音（個別設定保留）。";
    } else if (action === "quest") {
      const result = await questNotifyPref.toggle(client, userId, guildId);
      if (!result.ok) {
        await replyEphemeral(interaction, "🔧 通知功能暫時無法使用，請稍後再試。");
        return;
      }
      note = result.enabled
        ? "🔔 已開啟任務完成 DM 通知，被動任務完成時會私訊你。"
        : "🔕 已關閉任務完成 DM 通知，被動任務將靜默自動入帳。";
    } else if (reminder.TYPE_META[action]) {
      // mining / work / crash：到點通知
      const readyAt = await reminder.currentCooldownAt(client, {
        userId,
        guildId,
        type: action,
      });
      const result = await reminder.toggle(client, {
        userId,
        guildId,
        type: action,
        readyAt,
      });
      if (!result.ok) {
        await replyEphemeral(interaction, "🔧 通知功能暫時無法使用，請稍後再試。");
        return;
      }
      const meta = reminder.TYPE_META[action];
      // dungeon 是「體力補滿」語意，跟一般冷卻文案要分開講。
      const triggerWord = meta.notifyText ? "體力補滿" : "冷卻結束";
      if (result.enabled) {
        const tail =
          readyAt > Date.now()
            ? `目前${triggerWord}時（<t:${Math.floor(readyAt / 1000)}:R>）會私訊提醒你。`
            : `下次${triggerWord}時會私訊提醒你。`;
        note = `🔔 已開啟${meta.label}到點通知！${tail}`;
      } else {
        note = `🔕 已關閉${meta.label}到點通知。`;
      }
    } else {
      return;
    }

    // 就地重繪整個面板（含所有按鈕最新狀態）
    const container = await notifySettingsView.buildContainer(
      client,
      userId,
      guildId
    );
    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });

    // 開啟到點／任務通知但總開關關著時，補一句提醒
    if (
      note &&
      action !== "master" &&
      note.startsWith("🔔") &&
      !(await notifyPrefs.isMasterEnabled(client, userId, guildId))
    ) {
      note += "\n⚠️ 但通知總開關目前關閉中，要先開啟總開關才會真的收到提醒。";
    }
    if (note) await replyEphemeral(interaction, note);

    trackSuccess("notify-settings-toggle");
  } catch (err) {
    logger.error(
      {
        source: "notify-settings-toggle",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "切換通知設定時出錯"
    );
    trackError("notify-settings-toggle", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 切換通知失敗，請呼叫舒舒！");
  }
};
