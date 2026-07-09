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

async function performTransfer(client, { senderMember, targetMember, amount, note }) {
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

  const transferId = `xfer-${DateTime.now().toMillis()}-${senderId}-${target.id}`;

  const debit = await grantCoins(client, {
    userId: senderId,
    guildId,
    username: senderName,
    avatarHash: senderMember.user.avatar,
    amount: -amount,
    source: "transfer_out",
    member: senderMember,
    meta: { transferId, counterparty: target.id, amount, fee, note: note2 || null },
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
      meta: { transferId, counterparty: target.id, amount, feeRate },
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

  const credit = await grantCoins(client, {
    userId: target.id,
    guildId,
    username: target.username,
    avatarHash: target.avatar,
    amount,
    source: "transfer_in",
    member: targetMember,
    meta: { transferId, counterparty: senderId, amount, note: note2 || null },
  });
  if (!credit) {
    await grantCoins(client, {
      userId: senderId,
      guildId,
      username: senderName,
      amount: totalDeduct,
      source: "admin",
      meta: { reason: `transfer rollback: ${transferId}`, operatorId: "system" },
    }).catch(() => {});
    return { ok: false, reason: "credit_fail" };
  }

  fireSuspiciousTransferCheck(client, { guildId, senderId, recipientId: target.id });
  if (creditEnabled) {
    creditService.award(client, senderId, guildId, "transfer_complete", { member: senderMember }).catch(() => {});
  }

  return {
    ok: true,
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

module.exports = { performTransfer, computeFee };
