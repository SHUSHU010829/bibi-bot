const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { reveal, cashOut } = require("../../features/casino/mines/engine");
const { renderMessage } = require("../../features/casino/mines/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { MessageFlags } = require("discord.js");

function getMinesConfig() {
  return casino?.mines || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("mn_")) return;
    if (!client.minesGamesCollection) return;

    // customId 格式：mn_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("mn_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    const isCash = action === "cash";
    const isTile = /^t\d+$/.test(action);
    if (!isCash && !isTile) return;

    const rl = consume(interaction.user.id, "btn:mines", {
      windowMs: 700,
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
        logger.warn({ source: "mines-button", gameId }, "互動已逾期,無法 defer");
        trackError("mines-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const state = await client.minesGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "💣 這局已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的盤！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "💣 這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;

    let next;
    if (isCash) {
      if (!state.revealed?.length) {
        return interaction.followUp({
          content: "🚫 至少要翻 1 格才能收手！",
          flags: MessageFlags.Ephemeral,
        });
      }
      next = cashOut(state);
    } else {
      const tile = parseInt(action.slice(1), 10);
      if (state.revealed.includes(tile)) {
        return; // 已翻過的格，無視（deferUpdate 已回應）
      }
      next = reveal(state, tile);
    }

    const cfg = getMinesConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    await client.minesGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          revealed: next.revealed,
          hitTile: next.hitTile,
          multiplier: next.multiplier,
          status: next.status,
          result: next.result,
          payout: next.payout,
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
          game: "mines",
          result: next.result,
          gameId,
          bet: next.bet,
          mines: next.mines,
          revealed: next.revealed.length,
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
    trackSuccess("mines-button");
  } catch (error) {
    logger.error(
      {
        source: "mines-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "踩地雷按鈕處理失敗"
    );
    trackError("mines-button", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 踩地雷按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 踩地雷按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
