require("colors");
const { MessageFlags } = require("discord.js");
const { coinSystem, gift } = require("../../config");
const transferService = require("./transferService");
const giftService = require("../mining/giftService");
const { getItemDef } = require("../barter/itemCatalog");
const { buildOfferContainer, summaryOf } = require("./pendingTransferView");

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
async function setOfferMessage(client, offerId, channelId, messageId, isDm = false) {
  if (!client.pendingTransfersCollection) return;
  await client.pendingTransfersCollection
    .updateOne(
      { offer_id: offerId },
      { $set: { channel_id: channelId, message_id: messageId, dm: !!isDm } }
    )
    .catch(() => {});
}

async function guildNameOf(client, guildId) {
  const g = client.guilds?.cache?.get(guildId) || (await client.guilds?.fetch(guildId).catch(() => null));
  return g?.name || null;
}

// DM 收款人待收邀請（含收下 / 拒收按鈕）。成功回 { via:"dm" } 並記錄 DM 訊息位置；
// 對方關閉私訊 / 抓不到使用者則回 { via:"dm_failed" }，交由呼叫端 fallback 到頻道。
async function notifyRecipient(client, offer, { itemDef } = {}) {
  try {
    const user = await client.users.fetch(offer.recipient_id);
    const guildName = await guildNameOf(client, offer.guild_id);
    const msg = await user.send({
      components: [buildOfferContainer(offer, { itemDef, includeCancel: false, guildName })],
      flags: MessageFlags.IsComponentsV2,
    });
    await setOfferMessage(client, offer.offer_id, msg.channelId, msg.id, true);
    return { via: "dm" };
  } catch (_) {
    return { via: "dm_failed" };
  }
}

// /待收 清單：我要收的（incoming）＋ 我送出的（outgoing），只列仍有效的 pending。
async function listForUser(client, guildId, userId) {
  if (!client.pendingTransfersCollection) return { incoming: [], outgoing: [] };
  const now = new Date();
  const [incoming, outgoing] = await Promise.all([
    client.pendingTransfersCollection
      .find({ guild_id: guildId, recipient_id: userId, status: "pending", expires_at: { $gt: now } })
      .sort({ created_at: 1 })
      .toArray(),
    client.pendingTransfersCollection
      .find({ guild_id: guildId, sender_id: userId, status: "pending", expires_at: { $gt: now } })
      .sort({ created_at: 1 })
      .toArray(),
  ]);
  return { incoming, outgoing };
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
    dm: false,
    last_reminded_at: null,
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
    dm: false,
    last_reminded_at: null,
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

function reminderIntervalMs(kind) {
  const hours = kind === "coin" ? coinCfg().reminderIntervalHours : giftCfg().reminderIntervalHours;
  return (hours ?? 6) * 3600 * 1000;
}

// scheduler：對仍未回覆、距上次提醒已超過間隔的 pending offer 再 DM 提醒一次收款人。
// 回傳實際發出的提醒數。
async function sweepReminders(client) {
  if (!client.pendingTransfersCollection) return 0;
  const now = Date.now();
  const pending = await client.pendingTransfersCollection
    .find({ status: "pending", expires_at: { $gt: new Date(now) } })
    .toArray();

  let sent = 0;
  for (const offer of pending) {
    const baseline = new Date(offer.last_reminded_at || offer.created_at).getTime();
    if (now - baseline < reminderIntervalMs(offer.kind)) continue;

    try {
      const user = await client.users.fetch(offer.recipient_id);
      const label = offer.kind === "coin" ? "轉帳" : "贈送";
      const expiresEpoch = Math.floor(new Date(offer.expires_at).getTime() / 1000);
      await user.send({
        content:
          `⏳ 提醒：你有一筆待收${label}來自 <@${offer.sender_id}> — **${summaryOf(offer)}**，還沒回覆。\n` +
          `<t:${expiresEpoch}:R> 到期後會自動退回對方。到私訊或用 \`/待收\` 收下 / 拒收。`,
      });
      sent += 1;
    } catch (_) {
      // 對方關私訊就跳過，不影響到期退回
    }
    await client.pendingTransfersCollection
      .updateOne({ offer_id: offer.offer_id, status: "pending" }, { $set: { last_reminded_at: new Date(now) } })
      .catch(() => {});
  }
  return sent;
}

module.exports = {
  createCoinOffer,
  createItemOffer,
  setOfferMessage,
  notifyRecipient,
  listForUser,
  getOffer,
  acceptOffer,
  rejectOffer,
  cancelOffer,
  sweepExpired,
  sweepReminders,
};
