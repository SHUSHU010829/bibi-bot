require("colors");
const crypto = require("crypto");
const { coinSystem, bank } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");
const creditService = require("./creditService");

// 定期存款：把金幣鎖進定存，到期領回本金+利息；提前解約扣違約金。
// 業務邏輯集中在此，指令/按鈕層只呈現。

function cfg() {
  return coinSystem?.deposit || {};
}

function termRate(days) {
  const term = (cfg().terms || []).find((t) => t.days === days);
  return term ? term.rate : null;
}

function termChoices() {
  return (cfg().terms || []).map((t) => ({
    name: `${t.days} 天（年化 ${(t.rate * (365 / t.days) * 100).toFixed(1)}%，到期 +${(t.rate * 100).toFixed(1)}%）`,
    value: t.days,
  }));
}

function earlyPenaltyAmount(principal) {
  const penaltyRate = cfg().earlyWithdrawPenaltyRate ?? 0.1;
  return Math.floor(principal * penaltyRate);
}

// 提前解約會扣的信用分（config 名目值，正數；credit 未啟用回 0）。
function earlyCreditPenalty() {
  if (!bank?.credit?.enabled) return 0;
  return Math.abs((creditService.cfg().scoring || {}).early_withdraw || 0);
}

// 不寫入、只算「若現在領回會發生什麼」，給二次確認用。
async function previewClaim(client, { userId, guildId, depositId }) {
  const doc = await client.coinDepositsCollection.findOne({ depositId, userId, guildId });
  if (!doc) return { ok: false, reason: "notfound" };
  if (doc.status !== "active") return { ok: false, reason: "claimed" };

  const matured = new Date(doc.maturesAt).getTime() <= Date.now();
  if (matured) {
    return {
      ok: true,
      matured: true,
      depositId,
      principal: doc.principal,
      interest: doc.interest,
      payout: doc.principal + doc.interest,
      penaltyAmount: 0,
      creditPenalty: 0,
    };
  }
  const penaltyAmount = earlyPenaltyAmount(doc.principal);
  return {
    ok: true,
    matured: false,
    depositId,
    principal: doc.principal,
    interest: doc.interest,
    payout: Math.max(0, doc.principal - penaltyAmount),
    penaltyAmount,
    creditPenalty: earlyCreditPenalty(),
  };
}

async function maxActive(client, userId, guildId, member) {
  const slotBonus = twitchPerks.resolvePerks(member)?.depositSlotBonus || 0;
  const creditBonus = bank?.credit?.enabled
    ? (await creditService.getLimits(client, userId, guildId, member)).depositSlotBonus
    : 0;
  return (cfg().maxActivePerUser ?? 5) + slotBonus + creditBonus;
}

async function open(client, { userId, guildId, username, member, avatarHash, amount, days }) {
  const c = cfg();
  const min = c.minAmount ?? 100;
  const max = c.maxAmount ?? 100000;
  if (amount < min || amount > max) return { ok: false, reason: "range", min, max };

  const rate = termRate(days);
  if (rate == null) return { ok: false, reason: "term" };

  const limit = await maxActive(client, userId, guildId, member);
  const activeCount = await client.coinDepositsCollection.countDocuments({ userId, guildId, status: "active" });
  if (activeCount >= limit) return { ok: false, reason: "slots", maxActive: limit, activeCount };

  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = before?.totalCoins || 0;
  if (balance < amount) return { ok: false, reason: "balance", balance };

  const depositId = `dep_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date();
  const maturesAt = new Date(now.getTime() + days * 86400_000);
  const interest = Math.floor(amount * rate);

  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: -amount,
    source: "deposit_lock",
    member,
    meta: { depositId, days, rate, action: "open" },
  });
  if (!debit) return { ok: false, reason: "debit" };

  await client.coinDepositsCollection.insertOne({
    depositId,
    userId,
    guildId,
    username,
    principal: amount,
    days,
    rate,
    interest,
    status: "active",
    createdAt: now,
    maturesAt,
  });

  return {
    ok: true,
    depositId,
    amount,
    days,
    rate,
    interest,
    maturesAt,
    balanceAfter: debit.doc?.totalCoins ?? balance - amount,
  };
}

// 不截筆數：筆數上限由 maxActive() 在開戶時把關，這裡截斷會讓額度 > 20 的玩家看不到後面的定存
async function list(client, userId, guildId) {
  return client.coinDepositsCollection
    .find({ userId, guildId, status: "active" })
    .sort({ maturesAt: 1 })
    .toArray();
}

async function claim(client, { userId, guildId, username, member, avatarHash, depositId }) {
  const doc = await client.coinDepositsCollection.findOne({ depositId, userId, guildId });
  if (!doc) return { ok: false, reason: "notfound" };
  if (doc.status !== "active") return { ok: false, reason: "claimed" };

  const now = new Date();
  const matured = new Date(doc.maturesAt).getTime() <= now.getTime();
  let payout;
  let penaltyAmount = 0;

  if (matured) {
    payout = doc.principal + doc.interest;
  } else {
    penaltyAmount = earlyPenaltyAmount(doc.principal);
    payout = Math.max(0, doc.principal - penaltyAmount);
  }

  const upd = await client.coinDepositsCollection.findOneAndUpdate(
    { depositId, userId, guildId, status: "active" },
    { $set: { status: matured ? "claimed" : "early_claimed", claimedAt: now, payout, penaltyAmount } },
    { returnDocument: "after" },
  );
  if (!(upd.value || upd)) return { ok: false, reason: "race" };

  if (doc.principal > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash,
      amount: doc.principal,
      source: "deposit_release",
      member,
      meta: { depositId, early: !matured },
    });
  }
  if (matured && doc.interest > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash,
      amount: doc.interest,
      source: "deposit_interest",
      member,
      meta: { depositId, principal: doc.principal, days: doc.days, rate: doc.rate },
    });
  }
  if (!matured && penaltyAmount > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash,
      amount: -penaltyAmount,
      source: "deposit_penalty",
      member,
      meta: { depositId, principal: doc.principal },
    });
  }

  if (bank?.credit?.enabled) {
    if (matured) creditService.award(client, userId, guildId, "deposit_matured", { member }).catch(() => {});
    else creditService.penalize(client, userId, guildId, "early_withdraw", 1).catch(() => {});
  }

  return {
    ok: true,
    matured,
    payout,
    penaltyAmount,
    principal: doc.principal,
    interest: doc.interest,
    depositId,
    creditPenalty: matured ? 0 : earlyCreditPenalty(),
  };
}

module.exports = { cfg, termRate, termChoices, maxActive, open, list, previewClaim, claim };
