// CD 縮短券「🎫 使用」按鈕處理器。
//
// 按鈕 customId = mining_use_cd_ticket_<ownerId>（見 features/shop/backpackView.js）。
// 確認是本人後，消耗一張券直接縮短目前的挖礦冷卻，並就地刷新 /背包 訊息。

const { MessageFlags } = require("discord.js");

const { consume } = require("../../utils/rateLimiter");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const {
  buildBackpackView,
  parseUseTicketId,
} = require("../../features/shop/backpackView");
const mineService = require("../../features/mining/mineService");

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
    const parsed = parseUseTicketId(interaction.customId);
    if (!parsed) return;
    const { ownerId } = parsed;

    const rl = consume(interaction.user.id, "btn:miningUseCdTicket", {
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

    // 只有本人能用自己背包上的按鈕
    if (interaction.user.id !== ownerId) {
      await replyEphemeral(
        interaction,
        "🚫 這是別人的背包按鈕，請用 /背包 開自己的～"
      );
      return;
    }

    // 先確認互動，避免後續 DB 操作超過 3 秒 token 視窗
    await interaction.deferUpdate();

    const result = await mineService.useCdTicket(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });

    if (result.reason === "disabled") {
      await replyEphemeral(interaction, "🔧 挖礦系統尚未啟動！");
      return;
    }

    // 不論成敗都用最新狀態刷新背包卡片（修正可能已過期的冷卻顯示）
    const view = await buildBackpackView(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      displayName:
        interaction.member?.displayName ||
        interaction.user.displayName ||
        interaction.user.username,
    });
    await interaction.editReply(view);

    if (!result.ok) {
      const messages = {
        no_ticket: "🎫 你沒有 CD 縮短券，可到 /商店 購買。",
        not_in_cooldown: "✅ 你現在就能挖礦，不需要使用 CD 縮短券。",
        retry: "⏳ 操作衝突了，請再點一次。",
      };
      await replyEphemeral(interaction, messages[result.reason] || "🔧 使用失敗，請稍後再試。");
      return;
    }

    const note = result.clearedToReady
      ? "✅ 冷卻已歸零，現在就能 /挖礦！"
      : `🎫 已使用一張 CD 縮短券！下次可挖礦：<t:${Math.floor(result.newCooldownAt / 1000)}:R>`;
    await replyEphemeral(
      interaction,
      `${note}（剩餘 CD 縮短券 ×${result.ticketsLeft}）`
    );
    trackSuccess("mining-use-cd-ticket");
  } catch (err) {
    logger.error(
      {
        source: "mining-use-cd-ticket",
        customId: interaction?.customId,
        err: err.message,
        stack: err.stack,
      },
      "使用 CD 縮短券時出錯"
    );
    trackError("mining-use-cd-ticket", err, { customId: interaction?.customId });
    await replyEphemeral(interaction, "🔧 使用 CD 縮短券失敗，請呼叫舒舒！");
  }
};
