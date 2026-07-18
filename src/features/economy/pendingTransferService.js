require("colors");
const { coinSystem, gift } = require("../../config");
const transferService = require("./transferService");
const giftService = require("../mining/giftService");

// 待收轉帳 / 贈送：寄件方送出時先「託管」（扣款 / 扣物），收件方在 24 小時內
// 可選擇「收下」或「拒收」，逾時未答覆由 scheduler 自動退回。
//
// coin  → transferService.holdTransfer / deliverTransfer / refundTransfer
// item  → giftService.holdGift / deliverGift / refundGift

function coinCfg() {
  return coinSystem?.transfer || {};
}
function giftCfg() {
  return gift || {};
}

function genOfferId(senderId, recipientId) {
  return `ptx-${Date.now()}-${String(senderId).slice(-5)}${String(recipientId).slice(-5)}`;
}

async function countPending(client, guildId, senderId) {
  if (!client.pendingTransfersCollection) return 0;
  return client.pendingTransfersCollection.countDocuments({
    guild_id: guildId,
    sender_id: senderId,
    status: "pending",
  });
}

async function getOffer(client, offerId) {
  if (!client.pendingTransfersCollection) return null;
  return client.pendingTransfersCollection.findOne({ offer_id: offerId });
}

// 送出後把訊息位置寫回，讓 scheduler / handler 能編輯原訊息移除按鈕。
async function setOfferMessage(client, offerId, channelId, messageId) {
  if (!client.pendingTransfersCollection) return;
  await client.pendingTransfersCollection
    .updateOne(
      { offer_id: offerId },
      { $set: { channel_id: channelId, message_id: messageId } }
    )
    .catch(() => {});
}

// ── 建立邀請 ──────────────────────────────────────────────────────────────

async function createCoinOffer(client, { senderMember, targetMember, amount, note }) {
  if (!client.pendingTransfersCollection) return { ok: false, reason: "no_db" };

  const guildId = senderMember.guild.id;
  const senderId = senderMember.user.id;
  const maxPending = coinCfg().maxPendingPerUser ?? 10;
  if ((await countPending(client, guildId, senderId)) >= maxPending) {
    return { ok: false, reason: "too_many_pending", max: maxPending };
  }

  // 託管：立即扣寄件方本金 + 手續費
  const held = await transferService.holdTransfer(client, { senderMember, targetMember, amount, note });
  if (!held.ok) return held;

  const now = Date.now();
  const expiresMs = (coinCfg().offerExpiresHours ?? 24) * 3600 * 1000;
  const offer = {
    offer_id: genOfferId(senderId, targetMember.user.id),
    guild_id: guildId,
    kind: "coin",
    sender_id: senderId,
    sender_name: held.senderName,
    recipient_id: targetMember.user.id,
    recipient_name: targetMember.displayName || targetMember.user.username,
    amount: held.amount,
    fee: held.fee,
    fee_rate: held.feeRate,
    note: held.note || null,
    transfer_id: held.transferId,
    status: "pending",
    channel_id: null,
    message_id: null,
    created_at: new Date(now),
    expires_at: new Date(now + expiresMs),
    settled_at: null,
  };
  await client.pendingTransfersCollection.insertOne(offer);
  return { ok: true, offer, held };
}

async function createItemOffer(client, { giverMember, recipientUser, recipientMember, type, key, qty }) {
  if (!client.pendingTransfersCollection) return { ok: false, reason: "disabled" };

  const guildId = giverMember.guild.id;
  const giverId = giverMember.user.id;
  const maxPending = giftCfg().maxPendingPerUser ?? 10;
  if ((await countPending(client, guildId, giverId)) >= maxPending) {
    return { ok: false, reason: "too_many_pending", max: maxPending };
  }

  // 託管：立即扣送禮方物品 + 消耗當日次數
  const held = await giftService.holdGift(client, { giverId, guildId, type, key, qty });
  if (!held.ok) return held;

  const now = Date.now();
  const expiresMs = (giftCfg().offerExpiresHours ?? 24) * 3600 * 1000;
  const offer = {
    offer_id: genOfferId(giverId, recipientUser.id),
    guild_id: guildId,
    kind: "item",
    sender_id: giverId,
    sender_name: giverMember.displayName || giverMember.user.username,
    recipient_id: recipientUser.id,
    recipient_name: recipientMember?.displayName || recipientUser.username,
    item: { type, key, qty },
    status: "pending",
    channel_id: null,
    message_id: null,
    created_at: new Date(now),
    expires_at: new Date(now + expiresMs),
    settled_at: null,
  };
  await client.pendingTransfersCollection.insertOne(offer);
  return { ok: true, offer, itemDef: held.itemDef, usedToday: held.usedToday, dailyMax: held.dailyMax };
}

// ── 樂觀鎖：pending → settling，搶到才處理 ─────────────────────────────────

async function lockOffer(client, offerId) {
  const locked = await client.pendingTransfersCollection.findOneAndUpdate(
    { offer_id: offerId, status: "pending" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  return locked?.value || locked;
}

async function finalize(client, offerId, status) {
  await client.pendingTransfersCollection.updateOne(
    { offer_id: offerId },
    { $set: { status, settled_at: new Date(), updated_at: new Date() } }
  );
}

// 退回託管（拒收 / 逾時 / 交付失敗共用）。
async function refundEscrow(client, offer, reason) {
  if (offer.kind === "coin") {
    return transferService.refundTransfer(client, {
      senderId: offer.sender_id,
      guildId: offer.guild_id,
      senderName: offer.sender_name,
      member: null,
      amount: offer.amount,
      fee: offer.fee,
      transferId: offer.transfer_id,
      reason,
    });
  }
  return giftService.refundGift(client, {
    giverId: offer.sender_id,
    guildId: offer.guild_id,
    type: offer.item.type,
    key: offer.item.key,
    qty: offer.item.qty,
  });
}

// ── 收下 / 拒收 / 取消 / 逾時 ──────────────────────────────────────────────

async function acceptOffer(client, { offerId, actorUser, actorMember }) {
  if (!client.pendingTransfersCollection) return { ok: false, reason: "no_db" };
  const offer = await lockOffer(client, offerId);
  if (!offer) return { ok: false, reason: "gone" };

  // 鎖到但其實已過期 → 當退回處理，不交付
  if (new Date(offer.expires_at).getTime() < Date.now()) {
    await refundEscrow(client, offer, "expired").catch(() => {});
    await finalize(client, offerId, "expired");
    return { ok: false, reason: "expired", offer };
  }

  if (offer.kind === "coin") {
    const delivered = await transferService.deliverTransfer(client, {
      targetUser: actorUser,
      targetMember: actorMember,
      guildId: offer.guild_id,
      senderId: offer.sender_id,
      amount: offer.amount,
      note: offer.note,
      transferId: offer.transfer_id,
    });
    if (!delivered.ok) {
      await refundEscrow(client, offer, "deliver_failed").catch(() => {});
      await finalize(client, offerId, "failed");
      return { ok: false, reason: "deliver_failed", offer };
    }
    await finalize(client, offerId, "accepted");
    return { ok: true, kind: "coin", offer, recipientAfter: delivered.recipientAfter };
  }

  // item
  const delivered = await giftService.deliverGift(client, {
    recipientId: offer.recipient_id,
    recipientName: offer.recipient_name,
    guildId: offer.guild_id,
    type: offer.item.type,
    key: offer.item.key,
    qty: offer.item.qty,
  });
  if (!delivered.ok) {
    await refundEscrow(client, offer, "deliver_failed").catch(() => {});
    await finalize(client, offerId, "failed");
    return { ok: false, reason: "deliver_failed", offer };
  }
  await finalize(client, offerId, "accepted");
  return {
    ok: true,
    kind: "item",
    offer,
    itemDef: delivered.itemDef,
    deliveredQty: delivered.deliveredQty,
    overflowQty: delivered.overflowQty,
    overflowCoins: delivered.overflowCoins,
  };
}

async function rejectOffer(client, { offerId }) {
  if (!client.pendingTransfersCollection) return { ok: false, reason: "no_db" };
  const offer = await lockOffer(client, offerId);
  if (!offer) return { ok: false, reason: "gone" };
  await refundEscrow(client, offer, "rejected").catch(() => {});
  await finalize(client, offerId, "rejected");
  return { ok: true, offer };
}

async function cancelOffer(client, { offerId }) {
  if (!client.pendingTransfersCollection) return { ok: false, reason: "no_db" };
  const offer = await lockOffer(client, offerId);
  if (!offer) return { ok: false, reason: "gone" };
  await refundEscrow(client, offer, "cancelled").catch(() => {});
  await finalize(client, offerId, "cancelled");
  return { ok: true, offer };
}

// scheduler：撈出所有過期 pending，逐一退回。回傳已退回的 offer 清單供通知 / 編輯訊息。
async function sweepExpired(client) {
  if (!client.pendingTransfersCollection) return [];
  const expired = await client.pendingTransfersCollection
    .find({ status: "pending", expires_at: { $lte: new Date() } })
    .toArray();

  const done = [];
  for (const raw of expired) {
    const offer = await lockOffer(client, raw.offer_id);
    if (!offer) continue;
    await refundEscrow(client, offer, "expired").catch((e) =>
      console.log(`[ERROR] pending transfer refund ${offer.offer_id}: ${e}`.red)
    );
    await finalize(client, offer.offer_id, "expired");
    done.push(offer);
  }
  return done;
}

module.exports = {
  createCoinOffer,
  createItemOffer,
  setOfferMessage,
  getOffer,
  acceptOffer,
  rejectOffer,
  cancelOffer,
  sweepExpired,
};
