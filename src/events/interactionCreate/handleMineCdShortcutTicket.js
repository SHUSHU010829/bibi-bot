// 冷卻中的 /挖礦 訊息上「🎫 使用 CD 縮短券」按鈕處理器。
//
// 按鈕 customId = mine_cd_use_ticket_<ownerId>（見 commands/mining/mine.js）。
// 消耗一張 CD 縮短券後：
//   - 還在冷卻 → 就地更新挖礦訊息為新的剩餘時間與張數
//   - 冷卻歸零 → 直接呼叫 executeMine 把訊息換成挖礦結果，省去再打一次 /挖礦

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { mining } = require("../../config");
const {
  buildCooldownView,
  parseMineCdTicketId,
  executeMine,
} = require("../../commands/mining/mine");
const mineService = require("../../features/mining/mineService");
const reminder = require("../../features/reminders/cooldownReminderService");
const { deferUpdateSafe } = require("../../utils/safeAck");

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
    const parsed = parseMineCdTicketId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:mineCdShortcutTicket", {
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
        "🚫 這是別人的挖礦訊息按鈕，請呼叫自己的 /挖礦～",
      );
      return;
    }

    if (!(await deferUpdateSafe(interaction))) return;

    const result = await mineService.useCdTicket(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (result.ok) {
      await reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "mining",
        readyAt: result.newCooldownAt,
      });

      if (result.clearedToReady) {
        await executeMine(client, interaction, { allowOverflow: false });
        trackSuccess("mine-cd-shortcut-ticket");
        return;
      }

      const notifyState = await reminder.getState(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "mining",
      });
      const container = buildCooldownView({
        ownerId: interaction.user.id,
        readyAt: result.newCooldownAt,
        cdTickets: result.ticketsLeft,
        cdTicketUsedToday: result.usedToday,
        cdTicketDailyLimit: result.dailyLimit,
        cdTicketReductionMs: mining?.cdTicketReductionMs || 0,
        notifyEnabled: !!notifyState?.enabled,
        pickaxe: result.pickaxe,
        pickaxeDurability: result.pickaxeDurability,
        pickaxeMaxDurability: result.pickaxeMaxDurability,
      });
      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      trackSuccess("mine-cd-shortcut-ticket");
      return;
    }

    const messages = {
      disabled: "🔧 挖礦系統尚未啟動！",
      no_ticket: "🎫 你沒有 CD 縮短券了，可到 /商店 購買。",
      not_in_cooldown: "✅ 冷卻已經結束了，直接 /挖礦 吧！",
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
        source: "mine-cd-shortcut-ticket",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "使用 CD 縮短券（挖礦訊息按鈕）時出錯",
    );
    trackError("mine-cd-shortcut-ticket", err, {
      customId: interaction?.customId,
    });
    await replyEphemeral(interaction, "🔧 使用 CD 縮短券失敗，請呼叫舒舒！");
  }
};
