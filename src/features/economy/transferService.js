require("colors");
const { DateTime } = require("luxon");
const { coinSystem, bank } = require("../../config");
const grantCoins = require("./grantCoins");
const { checkServerTenure } = require("./eligibility");
const creditService = require("../bank/creditService");
const { fireImmediateCheck: fireSuspiciousTransferCheck } = require("./suspiciousTransferDetector");

// 玩家轉帳核心邏輯，/轉帳 指令與 /銀行 轉帳按鈕共用。回傳結構化結果，呈現交給呼叫端。

function computeFee(amount, cfg) {
  const baseRate = cfg?.feeRate ?? 0.02;
  const highRate = cfg?.feeRateHigh ?? 0.05;
  const threshold = cfg?.highFeeThreshold ?? 1000;
  const rate = amount > threshold ? highRate : baseRate;
  return { fee: Math.floor(amount * rate), rate };
}

function today() {
  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  return DateTime.now().setZone(tz).toISODate();
}

async function todayCount(client, userId, guildId) {
  if (!client.coinTransactionsCollection) return 0;
  return client.coinTransactionsCollection.countDocuments({
    userId,
    guildId,
    source: "transfer_out",
    date: today(),
  });
}

async function todayOut(client, userId, guildId) {
  if (!client.coinTransactionsCollection) return 0;
  const agg = await client.coinTransactionsCollection
    .aggregate([
      { $match: { userId, guildId, source: "transfer_out", date: today() } },
      { $group: { _id: null, total: { $sum: "$meta.amount" } } },
    ])
    .toArray();
  return agg[0]?.total || 0;
}

// 轉帳前的唯讀驗證：不動任何資料，回傳 { ok:true, ...ctx } 或 { ok:false, reason }。
// 供 /轉帳 建立待收邀請時先驗證，以及 performTransfer 實際執行前重跑一次。
async function precheckTransfer(client, { senderMember, targetMember, amount, note }) {
  const cfg = coinSystem?.transfer;
  if (!coinSystem?.enabled) return { ok: false, reason: "disabled_system" };
  if (!cfg?.enabled) return { ok: false, reason: "disabled_feature" };
  if (!client.userCoinsCollection || !client.coinTransactionsCollection) return { ok: false, reason: "no_db" };

  const senderId = senderMember.user.id;
  const guildId = senderMember.guild.id;
  const senderName = senderMember.displayName || senderMember.user.username;

  const tenure = checkServerTenure(senderMember);
  if (!tenure.ok) return { ok: false, reason: "tenure_sender", message: tenure.message };

  if (!targetMember) return { ok: false, reason: "no_member" };
  const target = targetMember.user;
  if (target.bot) return { ok: false, reason: "bot" };
  if (target.id === senderId) return { ok: false, reason: "self" };

  const note2 = (note || "").trim().slice(0, 80);

  const creditEnabled = bank?.credit?.enabled;
  const limits = creditEnabled ? await creditService.getLimits(client, senderId, guildId, senderMember) : null;
  const maxAmount = limits ? limits.transferMax : cfg.maxAmount ?? 20000;
  const dailyCap = limits ? limits.dailyCap : cfg.dailyCapPerSender ?? 20000;
  const dailyCount = limits ? limits.dailyCount : cfg.dailyCountFallback ?? 5;
  const minAmount = cfg.minAmount ?? 10;

  if (!(amount >= minAmount) || amount > maxAmount) {
    return { ok: false, reason: "range", min: minAmount, max: maxAmount, amount, limits };
  }

  const before = await client.userCoinsCollection.findOne({ userId: senderId, guildId });
  const balance = before?.totalCoins || 0;
  const { fee, rate: feeRate } = computeFee(amount, cfg);
  const totalDeduct = amount + fee;
  if (balance < totalDeduct) return { ok: false, reason: "balance", need: totalDeduct, balance, amount, fee };

  const countToday = await todayCount(client, senderId, guildId);
  if (countToday >= dailyCount) return { ok: false, reason: "count", countToday, dailyCount, limits };

  const usedToday = await todayOut(client, senderId, guildId);
  if (usedToday + amount > dailyCap) return { ok: false, reason: "cap", usedToday, dailyCap, amount };

  const recipientTenure = checkServerTenure(targetMember);
  if (!recipientTenure.ok) {
    return { ok: false, reason: "tenure_recipient", minDays: recipientTenure.minDays, eligibleEpoch: recipientTenure.eligibleEpoch };
  }

  return {
    ok: true,
    senderId,
    guildId,
    senderName,
    target,
    note2,
    fee,
    feeRate,
    totalDeduct,
    balance,
    countToday,
    usedToday,
    dailyCap,
    dailyCount,
    creditEnabled,
  };
}

// 託管：扣寄件方本金 + 手續費（先託管，尚未撥給收款人）。
// 用於 /轉帳 建立待收邀請時先扣款；收款人按「收下」才 deliverTransfer，
// 拒收 / 逾時則 refundTransfer 退回本金 + 手續費。
async function holdTransfer(client, { senderMember, targetMember, amount, note }) {
  const pre = await precheckTransfer(client, { senderMember, targetMember, amount, note });
  if (!pre.ok) return pre;

  const {
    senderId,
    guildId,
    senderName,
    target,
    note2,
    fee,
    feeRate,
    totalDeduct,
    balance,
    countToday,
    usedToday,
    dailyCap,
    dailyCount,
    creditEnabled,
  } = pre;

  const transferId = `xfer-${DateTime.now().toMillis()}-${senderId}-${target.id}`;

  const debit = await grantCoins(client, {
    userId: senderId,
    guildId,
    username: senderName,
    avatarHash: senderMember.user.avatar,
    amount: -amount,
    source: "transfer_out",
    member: senderMember,
    meta: { transferId, counterparty: target.id, amount, fee, note: note2 || null, held: true },
  });
  if (!debit) return { ok: false, reason: "debit" };

  let feeDebit = null;
  if (fee > 0) {
    feeDebit = await grantCoins(client, {
      userId: senderId,
      guildId,
      username: senderName,
      avatarHash: senderMember.user.avatar,
      amount: -fee,
      source: "transfer_fee",
      member: senderMember,
      meta: { transferId, counterparty: target.id, amount, feeRate, held: true },
    });
    if (!feeDebit) {
      await grantCoins(client, {
        userId: senderId,
        guildId,
        username: senderName,
        amount,
        source: "admin",
        meta: { reason: `transfer fee debit failed: ${transferId}`, operatorId: "system" },
      }).catch(() => {});
      return { ok: false, reason: "fee_debit" };
    }
  }

  fireSuspiciousTransferCheck(client, { guildId, senderId, recipientId: target.id });
  if (creditEnabled) {
    creditService.award(client, senderId, guildId, "transfer_complete", { member: senderMember }).catch(() => {});
  }

  return {
    ok: true,
    transferId,
    senderId,
    guildId,
    senderName,
    targetId: target.id,
    amount,
    fee,
    feeRate,
    note: note2,
    senderAfter: feeDebit?.doc?.totalCoins ?? debit.doc?.totalCoins ?? balance - totalDeduct,
    usedTodayAfter: usedToday + amount,
    dailyCap,
    countAfter: countToday + 1,
    dailyCount,
  };
}

// 撥款給收款人（收下時呼叫）。回傳 { ok, recipientAfter }。
async function deliverTransfer(client, { targetUser, targetMember, guildId, senderId, amount, note, transferId }) {
  const credit = await grantCoins(client, {
    userId: targetUser.id,
    guildId,
    username: targetUser.username,
    avatarHash: targetUser.avatar,
    amount,
    source: "transfer_in",
    member: targetMember,
    meta: { transferId, counterparty: senderId, amount, note: note || null },
  });
  if (!credit) return { ok: false };
  return { ok: true, recipientAfter: credit.doc?.totalCoins };
}

// 退回託管的本金 + 手續費（拒收 / 逾時 / 撥款失敗時呼叫）。回傳 { ok, senderAfter }。
async function refundTransfer(client, { senderId, guildId, senderName, member, amount, fee, transferId, reason }) {
  const refund = await grantCoins(client, {
    userId: senderId,
    guildId,
    username: senderName,
    member,
    amount: amount + (fee || 0),
    source: "transfer_refund",
    meta: { transferId, amount, fee: fee || 0, reason: reason || "refund" },
  });
  if (!refund) return { ok: false };
  return { ok: true, senderAfter: refund.doc?.totalCoins };
}

// 立即轉帳（託管 + 立刻撥款）。/銀行 快速轉帳仍走這條；撥款失敗自動退款。
async function performTransfer(client, { senderMember, targetMember, amount, note }) {
  const held = await holdTransfer(client, { senderMember, targetMember, amount, note });
  if (!held.ok) return held;

  const delivered = await deliverTransfer(client, {
    targetUser: targetMember.user,
    targetMember,
    guildId: held.guildId,
    senderId: held.senderId,
    amount: held.amount,
    note: held.note,
    transferId: held.transferId,
  });
  if (!delivered.ok) {
    await refundTransfer(client, {
      senderId: held.senderId,
      guildId: held.guildId,
      senderName: held.senderName,
      member: senderMember,
      amount: held.amount,
      fee: held.fee,
      transferId: held.transferId,
      reason: "deliver_failed",
    }).catch(() => {});
    return { ok: false, reason: "credit_fail" };
  }

  return {
    ok: true,
    targetId: held.targetId,
    amount: held.amount,
    fee: held.fee,
    feeRate: held.feeRate,
    note: held.note,
    senderAfter: held.senderAfter,
    usedTodayAfter: held.usedTodayAfter,
    dailyCap: held.dailyCap,
    countAfter: held.countAfter,
    dailyCount: held.dailyCount,
  };
}

module.exports = {
  performTransfer,
  precheckTransfer,
  holdTransfer,
  deliverTransfer,
  refundTransfer,
  computeFee,
};
