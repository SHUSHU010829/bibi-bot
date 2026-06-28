const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  scratch,
  scratchAll,
  isFullyRevealed,
  settle,
} = require("../../features/casino/scratch/engine");
const { renderMessage } = require("../../features/casino/scratch/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");
const { MessageFlags } = require("discord.js");

function getScratchConfig() {
  return casino?.scratch || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("sc_")) return;
    if (!client.scratchGamesCollection) return;

    // customId 格式：sc_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("sc_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    const isAll = action === "all";
    const isCell = /^c\d+$/.test(action);
    if (!isAll && !isCell) return;

    const rl = consume(interaction.user.id, "btn:scratch", {
      windowMs: 500,
      max: 1,
    });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    if (!(await deferUpdateSafe(interaction))) {
      logger.warn({ source: "scratch-button", gameId }, "互動已逾期,無法 defer");
      trackError("scratch-button", new Error("expired"), { gameId, reason: "expired" });
      return;
    }

    const state = await client.scratchGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🎫 這張卡已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的刮刮卡！別亂刮 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "🎫 這張卡已刮完。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;

    let next;
    if (isAll) {
      next = scratchAll(state);
    } else {
      const idx = parseInt(action.slice(1), 10);
      if (state.revealed.includes(idx)) return; // 已刮過，無視
      next = scratch(state, idx);
    }

    // 全部刮開後結算
    if (isFullyRevealed(next)) {
      next = settle(next);
    }

    const cfg = getScratchConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    await client.scratchGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          revealed: next.revealed,
          status: next.status,
          result: next.result,
          payout: next.payout,
          matchCount: next.matchCount,
          multiplier: next.multiplier,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + ttlSec * 1000),
        },
      }
    );

    let balanceAfter;
    if (next.status === "settled" && next.payout > 0) {
      const payoutResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: next.payout,
        source: "payout",
        member,
        meta: {
          game: "scratch",
          result: next.result,
          gameId,
          bet: next.bet,
          multiplier: next.multiplier,
        },
      });
      balanceAfter = payoutResult?.doc?.totalCoins;
    }
    if (balanceAfter === undefined) {
      const after = await client.userCoinsCollection.findOne({ userId, guildId });
      balanceAfter = after?.totalCoins || 0;
    }

    const payload = await renderMessage(
      { ...next, gameId, userId },
      {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      }
    );
    await interaction.editReply({ ...payload, attachments: [] });
    trackSuccess("scratch-button");
  } catch (error) {
    logger.error(
      {
        source: "scratch-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "刮刮樂按鈕處理失敗"
    );
    trackError("scratch-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 刮刮樂按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 刮刮樂按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
