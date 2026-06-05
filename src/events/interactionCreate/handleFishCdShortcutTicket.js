// 冷卻中的 /釣魚 訊息上「🎫 使用 CD 縮短券」按鈕處理器。
//
// 按鈕 customId = fish_cd_use_ticket_<ownerId>（見 commands/fishing/fish.js）。
// 消耗一張 CD 縮短券後：
//   - 還在冷卻 → 就地更新釣魚訊息為新的剩餘時間與張數
//   - 冷卻歸零 → 直接呼叫 executeFish 把訊息換成釣魚結果，省去再打一次 /釣魚

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { fishing } = require("../../config");
const {
  buildCooldownView,
  parseFishCdTicketId,
  executeFish,
} = require("../../commands/fishing/fish");
const fishService = require("../../features/fishing/fishService");
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
    const parsed = parseFishCdTicketId(interaction.customId);
    if (!parsed) return;
    const { ownerId, location } = parsed;

    const rl = consume(interaction.user.id, "btn:fishCdShortcutTicket", {
      windowMs: 1500,
      max: 1,
    });
    if (!rl.allowed) {
      await replyEphemeral(
        interaction,
        `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
      );
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的釣魚訊息按鈕，請呼叫自己的 /釣魚～",
      );
      return;
    }

    await interaction.deferUpdate();

    const result = await fishService.useCdTicket(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (result.ok) {
      await reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "fish",
        readyAt: result.newCooldownAt,
      });

      if (result.clearedToReady) {
        await executeFish(client, interaction, { location });
        trackSuccess("fish-cd-shortcut-ticket");
        return;
      }

      const notifyState = await reminder.getState(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "fish",
      });
      const container = buildCooldownView({
        ownerId: interaction.user.id,
        location,
        readyAt: result.newCooldownAt,
        cdTickets: result.ticketsLeft,
        cdTicketUsedToday: result.usedToday,
        cdTicketDailyLimit: result.dailyLimit,
        cdTicketReductionMs: fishing?.cdTicketReductionMs || 0,
        notifyEnabled: !!notifyState?.enabled,
        rodKey: result.rodKey,
        rodDurability: result.rodDurability,
        rodMaxDurability: result.rodMaxDurability,
      });
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("fish-cd-shortcut-ticket");
      return;
    }

    const messages = {
      disabled: "🔧 釣魚系統尚未啟動！",
      no_ticket: "🎫 你沒有 CD 縮短券了，可到 /商店 購買。",
      not_in_cooldown: "✅ 冷卻已經結束了，直接 /釣魚 吧！",
      daily_limit: `🎫 CD 縮短券每日最多使用 ${result.limit} 張，今天已用完，明天再來吧！`,
      retry: "⏳ 操作衝突了，請再點一次。",
    };
    await replyEphemeral(
      interaction,
      messages[result.reason] || "🔧 使用失敗，請稍後再試。",
    );
  } catch (err) {
    logger.error(
      {
        source: "fish-cd-shortcut-ticket",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "使用 CD 縮短券（釣魚訊息按鈕）時出錯",
    );
    trackError("fish-cd-shortcut-ticket", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 使用 CD 縮短券失敗，請呼叫舒舒！");
  }
};
