// 俄羅斯輪盤共用收尾：開轉結算 / 取消退款。
// 由按鈕處理器與到期排程共用，靠 status 的 atomic 轉移防重複。

require("colors");
const { casino } = require("../../../config");
const grantCoins = require("../../economy/grantCoins");
const { notifyEmbed } = require("../notifyAbandon");
const { MONEY_EMOJI } = require("../../../constants/coin");
const { resolve } = require("./engine");
const {
  buildFinishedPayload,
  buildCancelledPayload,
} = require("./render");

async function editTableMessage(client, state, payload) {
  try {
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (channel?.isTextBased?.() && state.messageId) {
      const msg = await channel.messages.fetch(state.messageId).catch(() => null);
      if (msg) await msg.edit(payload);
    }
  } catch (e) {
    console.log(`[ROULETTE] edit message failed ${state.gameId}: ${e}`.yellow);
  }
}

async function cancelAndRefund(client, gameId, { reason = "cancelled" } = {}) {
  const claimed = await client.russianRouletteGamesCollection.findOneAndUpdate(
    { gameId, status: "waiting" },
    { $set: { status: "settling", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const state = claimed?.value || claimed;
  if (!state) return { ok: false };

  const reasonText =
    reason === "not_enough" ? "因人數不足 2 人取消" : "取消了";
  for (const p of state.players) {
    await grantCoins(client, {
      userId: p.userId,
      guildId: state.guildId,
      username: p.username,
      amount: p.ante,
      source: "payout",
      meta: { game: "russianRoulette", gameId, kind: "refund", reason },
    }).catch((e) => console.log(`[ROULETTE] refund fail ${gameId}: ${e}`.yellow));
    await notifyEmbed(client, p.userId, {
      title: "🔫 俄羅斯輪盤退款",
      description: `你加入的這桌${reasonText}，賭注 **${(p.ante || 0).toLocaleString()}** ${MONEY_EMOJI} 已退回。`,
    });
  }

  await client.russianRouletteGamesCollection.updateOne(
    { gameId },
    { $set: { status: "cancelled", cancelReason: reason, updatedAt: new Date() } }
  );
  await editTableMessage(client, state, buildCancelledPayload(state, { reason }));
  return { ok: true };
}

async function startGame(client, gameId) {
  const cfg = casino?.russianRoulette || {};
  const rakePct = cfg.rakePct ?? 0.05;

  // 先看人數；不足 2 人就走退款流程
  const peek = await client.russianRouletteGamesCollection.findOne({ gameId, status: "waiting" });
  if (!peek) return { ok: false };
  if ((peek.players?.length || 0) < 2) {
    return cancelAndRefund(client, gameId, { reason: "not_enough" });
  }

  const claimed = await client.russianRouletteGamesCollection.findOneAndUpdate(
    { gameId, status: "waiting", $expr: { $gte: [{ $size: "$players" }, 2] } },
    { $set: { status: "settling", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const state = claimed?.value || claimed;
  if (!state) return { ok: false };

  const outcome = resolve(state.players, { rakePct });

  for (const w of outcome.payouts) {
    if (w.amount <= 0) continue;
    const player = state.players.find((p) => p.userId === w.userId);
    await grantCoins(client, {
      userId: w.userId,
      guildId: state.guildId,
      username: player?.username,
      amount: w.amount,
      source: "payout",
      meta: { game: "russianRoulette", gameId, kind: "win" },
    }).catch((e) => console.log(`[ROULETTE] payout fail ${gameId}: ${e}`.yellow));
  }

  const finished = {
    ...state,
    status: "finished",
    loserIndex: outcome.loserIndex,
    loserId: outcome.loserId,
    pot: outcome.pot,
    perWinner: outcome.perWinner,
    payouts: outcome.payouts,
  };

  await client.russianRouletteGamesCollection.updateOne(
    { gameId },
    {
      $set: {
        status: "finished",
        loserIndex: outcome.loserIndex,
        loserId: outcome.loserId,
        pot: outcome.pot,
        perWinner: outcome.perWinner,
        payouts: outcome.payouts,
        rake: outcome.rake,
        updatedAt: new Date(),
      },
    }
  );

  await editTableMessage(client, finished, buildFinishedPayload(finished));
  return { ok: true };
}

module.exports = { startGame, cancelAndRefund };
