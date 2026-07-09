require("colors");
const crypto = require("crypto");
const { bank } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const creditService = require("./creditService");

// 貸款：憑信用分額度借款，到期一次還本息。逾期每日加罰並扣信用分，
// 超過寬限天數視為違約（大幅扣信用分、封鎖新貸款直到還清）。

function cfg() {
  return bank?.loan || {};
}

async function listActive(client, userId, guildId) {
  return client.loansCollection
    .find({ userId, guildId, status: { $in: ["active", "defaulted"] } })
    .sort({ dueAt: 1 })
    .toArray();
}

async function hasDefault(client, userId, guildId) {
  const n = await client.loansCollection.countDocuments({ userId, guildId, status: "defaulted" });
  return n > 0;
}

// 逾期（已過期未還）或已違約的貸款 → 用來凍結提領。回傳 { loanId, outstanding, defaulted } 或 null。
async function repaymentBlock(client, userId, guildId) {
  if (!cfg().freezeWithdrawOnOverdue) return null;
  const col = client.loansCollection;
  if (!col) return null;
  const loan = await col.findOne(
    {
      userId,
      guildId,
      $or: [{ status: "defaulted" }, { status: "active", dueAt: { $lt: new Date() } }],
    },
    { sort: { dueAt: 1 } },
  );
  if (!loan) return null;
  return {
    loanId: loan.loanId,
    outstanding: loan.dueAmount - (loan.paid || 0),
    defaulted: loan.status === "defaulted",
  };
}

async function take(client, { userId, guildId, member, username, avatarHash, amount }) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  const minAmount = c.minAmount ?? 1000;
  if (amount < minAmount) return { ok: false, reason: "min", minAmount };

  const limits = await creditService.getLimits(client, userId, guildId, member);
  const loanCap = limits.loanCap || 0;
  if (loanCap <= 0) return { ok: false, reason: "tier", tier: limits.tier, next: limits.next };
  if (amount > loanCap) return { ok: false, reason: "cap", loanCap, tier: limits.tier };

  if (c.blockNewOnDefault && (await hasDefault(client, userId, guildId))) {
    return { ok: false, reason: "default_block" };
  }

  const active = await client.loansCollection.countDocuments({
    userId,
    guildId,
    status: { $in: ["active", "defaulted"] },
  });
  const maxActive = c.maxActivePerUser ?? 1;
  if (active >= maxActive) return { ok: false, reason: "active", maxActive, active };

  const rate = c.interestRate ?? 0.1;
  const termDays = c.termDays ?? 7;
  const interest = Math.floor(amount * rate);
  const dueAmount = amount + interest;
  const now = new Date();
  const dueAt = new Date(now.getTime() + termDays * 86400000);
  const loanId = `loan_${crypto.randomBytes(4).toString("hex")}`;

  const credit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount,
    source: "loan_out",
    member,
    meta: { loanId, dueAmount, rate },
  });
  if (!credit) return { ok: false, reason: "disburse" };

  await client.loansCollection.insertOne({
    loanId,
    userId,
    guildId,
    principal: amount,
    interest,
    interestRate: rate,
    dueAmount,
    paid: 0,
    overdueDays: 0,
    status: "active",
    disbursedAt: now,
    dueAt,
  });

  return { ok: true, loanId, amount, interest, dueAmount, dueAt, walletAfter: credit.doc?.totalCoins };
}

async function repay(client, { userId, guildId, member, username, avatarHash, loanId, amount }) {
  const query = { userId, guildId, status: { $in: ["active", "defaulted"] } };
  if (loanId) query.loanId = loanId;
  const loan = await client.loansCollection.findOne(query, { sort: { dueAt: 1 } });
  if (!loan) return { ok: false, reason: "notfound" };

  const outstanding = loan.dueAmount - (loan.paid || 0);
  const pay = amount && amount > 0 ? Math.min(amount, outstanding) : outstanding;
  if (pay <= 0) return { ok: false, reason: "settled" };

  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const wallet = before?.totalCoins || 0;
  if (wallet < pay) return { ok: false, reason: "wallet", wallet, outstanding, loan };

  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: -pay,
    source: "loan_repay",
    member,
    meta: { loanId: loan.loanId, pay },
  });
  if (!debit) return { ok: false, reason: "debit" };

  const newPaid = (loan.paid || 0) + pay;
  const cleared = newPaid >= loan.dueAmount;
  await client.loansCollection.updateOne(
    { loanId: loan.loanId },
    {
      $set: {
        paid: newPaid,
        status: cleared ? "repaid" : loan.status,
        ...(cleared ? { repaidAt: new Date() } : {}),
        updatedAt: new Date(),
      },
    },
  );
  if (cleared && loan.status === "active") {
    creditService.award(client, userId, guildId, "loan_repaid", { member }).catch(() => {});
  }
  return {
    ok: true,
    pay,
    cleared,
    remaining: Math.max(0, loan.dueAmount - newPaid),
    loan,
    walletAfter: debit.doc?.totalCoins ?? wallet - pay,
  };
}

// 排程用：處理所有逾期貸款，加罰、扣信用、標記違約。回傳處理統計。
async function processOverdue(client) {
  const col = client.loansCollection;
  if (!col) return { penalized: 0, defaulted: 0 };
  const c = cfg();
  const now = new Date();
  const due = await col.find({ status: "active", dueAt: { $lt: now } }).toArray();
  let penalized = 0;
  let defaulted = 0;
  const penaltyRate = c.overdueDailyPenaltyRate ?? 0.03;
  const defaultAfter = c.defaultAfterDays ?? 14;

  for (const loan of due) {
    const overdueDays = (loan.overdueDays || 0) + 1;
    const penalty = Math.floor(loan.principal * penaltyRate);
    const isDefault = overdueDays >= defaultAfter;
    await col.updateOne(
      { loanId: loan.loanId },
      {
        $inc: { dueAmount: penalty },
        $set: { overdueDays, status: isDefault ? "defaulted" : "active", updatedAt: now },
      },
    );
    await creditService.penalize(client, loan.userId, loan.guildId, "loan_overdue_daily", 1).catch(() => {});
    penalized += 1;
    if (isDefault) {
      await creditService.penalize(client, loan.userId, loan.guildId, "loan_default", 1).catch(() => {});
      defaulted += 1;
    }
  }
  return { penalized, defaulted };
}

module.exports = {
  cfg,
  listActive,
  hasDefault,
  repaymentBlock,
  take,
  repay,
  processOverdue,
};
