const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { guess, cashOut } = require("../../features/casino/hilo/engine");
const { renderMessage } = require("../../features/casino/hilo/renderer");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { MessageFlags } = require("discord.js");

function getHiloConfig() {
  return casino?.hilo || {};
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("hl_")) return;
    if (!client.hiloGamesCollection) return;

    // customId 格式：hl_<action>_<gameId>，gameId 是 uuid 含 "-"
    const rest = interaction.customId.slice("hl_".length);
    const splitIdx = rest.indexOf("_");
    if (splitIdx < 0) return;
    const action = rest.slice(0, splitIdx);
    const gameId = rest.slice(splitIdx + 1);

    if (!["hi", "lo", "same", "cash"].includes(action)) return;

    // 速率限制：擋連點，避免製造 10062
    const rl = consume(interaction.user.id, "btn:hilo", {
      windowMs: 1000,
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

    // 先 defer，避免 DB 查詢 + 驗證讓 3 秒 token 過期觸發 10062
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "hilo-button", gameId },
          "互動已逾期,無法 defer"
        );
        trackError("hilo-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const state = await client.hiloGamesCollection.findOne({ gameId });
    if (!state) {
      return interaction.followUp({
        content: "🎴 這局已過期或找不到了。",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.userId !== interaction.user.id) {
      return interaction.followUp({
        content: "🚫 這不是你的局！別亂按 ㄎㄎ",
        flags: MessageFlags.Ephemeral,
      });
    }
    if (state.status !== "playing") {
      return interaction.followUp({
        content: "🎴 這局已結束。",
        flags: MessageFlags.Ephemeral,
      });
    }

    const userId = state.userId;
    const guildId = state.guildId;
    const username = state.username || interaction.user.username;
    const member = interaction.member;

    let next;
    if (action === "cash") {
      if (!state.wins || state.wins <= 0) {
        return interaction.followUp({
          content: "🚫 至少要贏一把才能收手！",
          flags: MessageFlags.Ephemeral,
        });
      }
      next = cashOut(state);
    } else {
      next = guess(state, action);
    }

    const cfg = getHiloConfig();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const now = new Date();

    await client.hiloGamesCollection.updateOne(
      { _id: state._id },
      {
        $set: {
          deck: next.deck,
          baseCard: next.baseCard,
          history: next.history,
          accMultiplier: next.accMultiplier,
          wins: next.wins,
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
          game: "hilo",
          result: next.result,
          gameId,
          bet: next.bet,
          wins: next.wins,
          accMultiplier: next.accMultiplier,
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
    await interaction.editReply({
      ...payload,
      attachments: [],
    });
    trackSuccess("hilo-button");
  } catch (error) {
    logger.error(
      { source: "hilo-button", userId: interaction.user?.id, customId: interaction.customId, err: error.message, stack: error.stack },
      "HI-LO 按鈕處理失敗"
    );
    trackError("hilo-button", error, { userId: interaction.user?.id, customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 HI-LO 按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 HI-LO 按鈕處理失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
