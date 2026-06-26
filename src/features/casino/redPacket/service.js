// 搶紅包共用收尾邏輯：把一包紅包關閉、退回未搶金額給發包人、更新訊息。
// 由按鈕處理器（搶光時）與到期排程共用，靠 atomic update 防重複關閉。

require("colors");
const grantCoins = require("../../economy/grantCoins");
const { notifyDm } = require("../notifyAbandon");
const { buildClosedPayload } = require("./render");

// 嘗試把一包 open 的紅包關閉。回傳 { closed, refunded }。
// atomic：findOneAndUpdate 只在 status 仍為 "open" 時搶到關閉權，確保退款只跑一次。
async function closeRedPacket(client, gameId, { reason = "expired" } = {}) {
  if (!client.redPacketGamesCollection) return { closed: false, refunded: 0 };

  const claimed = await client.redPacketGamesCollection.findOneAndUpdate(
    { gameId, status: "open" },
    { $set: { status: "closing", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const state = claimed?.value || claimed;
  if (!state) return { closed: false, refunded: 0 };

  const grabbedAmount = (state.grabbers || []).reduce((s, g) => s + g.amount, 0);
  const refunded = Math.max(0, state.totalAmount - grabbedAmount);

  if (refunded > 0) {
    await grantCoins(client, {
      userId: state.hostUserId,
      guildId: state.guildId,
      username: state.hostUsername,
      amount: refunded,
      source: "payout",
      meta: { game: "redPacket", gameId, kind: "refund", reason },
    }).catch((e) =>
      console.log(`[REDPACKET] refund failed ${gameId}: ${e}`.yellow)
    );
    await notifyDm(
      client,
      state.hostUserId,
      `🧧 你發的紅包還剩 **${refunded.toLocaleString()}** credits 沒被搶完，已退回給你。\n-# 款項一定回到你身上 👍`
    );
  }

  await client.redPacketGamesCollection.updateOne(
    { gameId },
    { $set: { status: "closed", refunded, closedReason: reason, updatedAt: new Date() } }
  );

  // 更新原訊息為結算畫面
  try {
    const channel = await client.channels.fetch(state.channelId).catch(() => null);
    if (channel?.isTextBased?.() && state.messageId) {
      const msg = await channel.messages.fetch(state.messageId).catch(() => null);
      if (msg) await msg.edit(buildClosedPayload(state, { refunded }));
    }
  } catch (e) {
    console.log(`[REDPACKET] edit message failed ${gameId}: ${e}`.yellow);
  }

  return { closed: true, refunded };
}

module.exports = { closeRedPacket };
