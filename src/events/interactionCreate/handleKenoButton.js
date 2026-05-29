const { MessageFlags } = require("discord.js");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  togglePick,
  quickPick,
  clearPicks,
  reveal,
  cancel,
} = require("../../features/casino/keno/engine");
const { renderMessage } = require("../../features/casino/keno/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

function getKenoConfig() {
  return casino?.keno || {};
}

// customId 格式：
//   k_t_<tile>_<gameId>  → 切換選格
//   k_q_<gameId>         → 機選
//   k_r_<gameId>         → 重選
//   k_d_<gameId>         → 開獎
//   k_x_<gameId>         → 取消退款
function parseCustomId(customId) {
  if (!customId.startsWith("k_")) return null;
  const rest = customId.slice(2);
  const action = rest[0];
  if (!"tqrdx".includes(action)) return null;
  if (rest[1] !== "_") return null;
  const after = rest.slice(2);

  if (action === "t") {
    // <tile>_<gameId>
    const sep = after.indexOf("_");
    if (sep < 0) return null;
    const tile = parseInt(after.slice(0, sep), 10);
    const gameId = after.slice(sep + 1);
    if (!Number.isInteger(tile)) return null;
    return { action, tile, gameId };
  }
  return { action, gameId: after };
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("k_")) return;
    if (!client.kenoGamesCollection) return;

    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    const { action, tile, gameId } = parsed;

    // 速率限制
    const rl = consume(interaction.user.id, "btn:keno", {
      windowMs: 800,
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

    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "keno-button", gameId },
          "互動已逾期,無法 defer"
        );
        trackError("keno-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const state = await client.kenoGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🗺️ 這張尋寶圖已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的尋寶圖！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "selecting") {
      return interaction.followUp({
        content: "🗺️ 這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;

    let next = state;
    if (action === "t") {
      next = togglePick(next, tile);
    } else if (action === "q") {
      next = quickPick(next);
    } else if (action === "r") {
      next = clearPicks(next);
    } else if (action === "d") {
      if (next.picks.length !== next.pickCount) {
        return interaction.followUp({
          content: `🚫 請先選滿 ${next.pickCount} 格再開獎。`,
          flags: MessageFlags.Ephemeral,
        });
      }
      next = reveal(next);
    } else if (action === "x") {
      next = cancel(next);
    }

    const cfg = getKenoConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    await client.kenoGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          picks: next.picks,
          status: next.status,
          hitCount: next.hitCount,
          multiplier: next.multiplier,
          payout: next.payout,
          result: next.result,
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
          game: "keno",
          gameId,
          bet: next.bet,
          hitCount: next.hitCount,
          multiplier: next.multiplier,
          picks: next.picks,
          treasures: next.treasures,
        },
      });
      balanceAfter = payoutResult?.doc?.totalCoins;
    } else if (next.status === "cancelled") {
      // 退還本金
      const refundResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        amount: next.bet,
        source: "payout",
        member,
        meta: { game: "keno", gameId, result: "cancelled_refund" },
      });
      balanceAfter = refundResult?.doc?.totalCoins;
    }

    if (balanceAfter === undefined) {
      const after = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      balanceAfter = after?.totalCoins || 0;
    }

    const payload = renderMessage(
      { ...next, gameId, userId },
      {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      }
    );
    await interaction.editReply({ ...payload, attachments: [] });
    trackSuccess("keno-button");
  } catch (error) {
    logger.error(
      {
        source: "keno-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "尋寶按鈕處理失敗"
    );
    trackError("keno-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 尋寶按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 尋寶按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
