// 俄羅斯輪盤按鈕：rr_join_<gameId> / rr_start_<gameId> / rr_cancel_<gameId>。

const { MessageFlags } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../../features/economy/grantCoins");
const { buildWaitingPayload } = require("../../features/casino/russianRoulette/render");
const { startGame, cancelAndRefund } = require("../../features/casino/russianRoulette/service");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");
const { deferUpdateSafe } = require("../../utils/safeAck");

async function ephemeral(interaction, content) {
  try {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch (_) {
    /* noop */
  }
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId || "";
    if (!/^rr_(join|start|cancel)_/.test(id)) return;
    if (!client.russianRouletteGamesCollection) return;

    const action = id.startsWith("rr_join_")
      ? "join"
      : id.startsWith("rr_start_")
        ? "start"
        : "cancel";
    const gameId = id.slice(`rr_${action}_`.length);
    const userId = interaction.user.id;
    const username = interaction.member?.displayName || interaction.user.username;

    const rl = consume(userId, "btn:russianRoulette", { windowMs: 800, max: 1 });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 慢一點，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    if (!(await deferUpdateSafe(interaction))) return;

    const state = await client.russianRouletteGamesCollection.findOne({ gameId });
    if (!state) return ephemeral(interaction, "🔫 這桌找不到了。");
    if (state.status !== "waiting") {
      return ephemeral(interaction, "🔫 這桌已經開轉或結束了。");
    }

    if (action === "start" || action === "cancel") {
      if (userId !== state.hostUserId) {
        return ephemeral(interaction, "🔫 只有開桌的莊家能開轉 / 取消這桌。");
      }
      if (action === "start") {
        const r = await startGame(client, gameId);
        if (!r.ok) return ephemeral(interaction, "🔫 開轉失敗或已結束。");
        return trackSuccess("russianroulette-button");
      }
      await cancelAndRefund(client, gameId, { reason: "cancelled" });
      return trackSuccess("russianroulette-button");
    }

    // join
    if (state.players.some((p) => p.userId === userId)) {
      return ephemeral(interaction, "🔫 你已經在這桌了！");
    }
    if (state.players.length >= state.maxPlayers) {
      return ephemeral(interaction, "🔫 滿桌了，等下一局吧～");
    }

    const before = await client.userCoinsCollection.findOne({ userId, guildId: state.guildId });
    const balance = before?.totalCoins || 0;
    if (balance < state.ante) {
      return ephemeral(
        interaction,
        `${MONEY_EMOJI} 餘額不足！加入要押 **${state.ante.toLocaleString()}**，你只有 **${balance.toLocaleString()}**。`
      );
    }

    const updated = await client.russianRouletteGamesCollection.findOneAndUpdate(
      {
        gameId,
        status: "waiting",
        "players.userId": { $ne: userId },
        $expr: { $lt: [{ $size: "$players" }, "$maxPlayers"] },
      },
      {
        $push: { players: { userId, username, ante: state.ante } },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" }
    );
    const next = updated?.value || updated;
    if (!next) {
      return ephemeral(interaction, "🔫 來晚一步，滿桌或已開轉了。");
    }

    await grantCoins(client, {
      userId,
      guildId: state.guildId,
      username,
      avatarHash: interaction.user.avatar,
      amount: -state.ante,
      source: "bet",
      member: interaction.member,
      meta: { game: "russianRoulette", gameId, kind: "ante" },
    });

    await interaction.editReply(buildWaitingPayload(next)).catch(() => {});
    await ephemeral(interaction, `🔫 你加入了！押了 **${state.ante.toLocaleString()}** ${MONEY_EMOJI}，等莊家開轉。`);
    trackSuccess("russianroulette-button");
  } catch (error) {
    logger.error(
      {
        source: "russianroulette-button",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "俄羅斯輪盤按鈕處理失敗"
    );
    trackError("russianroulette-button", error, { customId: interaction.customId });
    await ephemeral(interaction, "🔧 操作失敗，請呼叫舒舒！");
  }
};
