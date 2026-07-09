require("colors");
const { bank } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const creditService = require("./creditService");
const loanService = require("./loanService");

// 活期存款：隨存隨取，利息以「上次結算時間」compute-on-read。
// 本金存在帳戶（不在錢包），存入時錢包扣款（sink），提領時錢包入帳（flat reward）。
// 利息在每次操作/查詢時依經過天數結算入本金（realize on touch）。

function cfg() {
  return bank?.savings || {};
}

function pendingInterest(balance, lastSettledAt) {
  if (!balance || !lastSettledAt) return 0;
  const elapsedDays = (Date.now() - new Date(lastSettledAt).getTime()) / 86400000;
  if (elapsedDays <= 0) return 0;
  const rate = cfg().dailyRate ?? 0;
  return Math.floor(balance * rate * elapsedDays);
}

async function getAccount(client, userId, guildId) {
  const col = client.savingsAccountsCollection;
  if (!col) return null;
  return col.findOne({ userId, guildId }).catch(() => null);
}

// 結算利息入本金，回傳最新帳戶。無帳戶回傳 null。
async function settle(client, userId, guildId) {
  const col = client.savingsAccountsCollection;
  const acc = await getAccount(client, userId, guildId);
  if (!acc) return null;
  const minted = pendingInterest(acc.balance || 0, acc.lastSettledAt);
  if (minted <= 0) return acc;
  const res = await col.findOneAndUpdate(
    { userId, guildId },
    { $inc: { balance: minted, lifetimeInterest: minted }, $set: { lastSettledAt: new Date() } },
    { returnDocument: "after" },
  );
  return res.value || res;
}

async function view(client, userId, guildId) {
  const acc = await settle(client, userId, guildId);
  const balance = acc?.balance || 0;
  return { balance, lifetimeInterest: acc?.lifetimeInterest || 0, dailyRate: cfg().dailyRate ?? 0 };
}

async function deposit(client, { userId, guildId, username, member, avatarHash, amount }) {
  const c = cfg();
  const minOp = c.minOp ?? 100;
  if (amount < minOp) return { ok: false, reason: "min", minOp };

  await settle(client, userId, guildId);
  const acc = await getAccount(client, userId, guildId);
  const curBalance = acc?.balance || 0;
  const maxBalance = c.maxBalance ?? Infinity;
  if (curBalance + amount > maxBalance) {
    return { ok: false, reason: "cap", maxBalance, curBalance };
  }

  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const wallet = before?.totalCoins || 0;
  if (wallet < amount) return { ok: false, reason: "wallet", wallet };

  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: -amount,
    source: "savings_deposit",
    member,
    meta: { amount },
  });
  if (!debit) return { ok: false, reason: "debit" };

  const now = new Date();
  const res = await client.savingsAccountsCollection.findOneAndUpdate(
    { userId, guildId },
    {
      $inc: { balance: amount },
      $setOnInsert: { userId, guildId, createdAt: now, lastSettledAt: now, lifetimeInterest: 0 },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  const balance = (res.value || res)?.balance || amount;
  return { ok: true, amount, balance, walletAfter: debit.doc?.totalCoins ?? wallet - amount };
}

async function withdraw(client, { userId, guildId, username, member, avatarHash, amount }) {
  const block = await loanService.repaymentBlock(client, userId, guildId);
  if (block) return { ok: false, reason: "loan_frozen", block };

  await settle(client, userId, guildId);
  const acc = await getAccount(client, userId, guildId);
  const balance = acc?.balance || 0;
  if (amount < 1) return { ok: false, reason: "min" };
  if (balance < amount) return { ok: false, reason: "balance", balance };

  const res = await client.savingsAccountsCollection.findOneAndUpdate(
    { userId, guildId, balance: { $gte: amount } },
    { $inc: { balance: -amount }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!(res.value || res)) return { ok: false, reason: "race" };

  const credit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount,
    source: "savings_withdraw",
    member,
    meta: { amount },
  });
  if (!credit) {
    await client.savingsAccountsCollection.updateOne(
      { userId, guildId },
      { $inc: { balance: amount } },
    );
    return { ok: false, reason: "credit" };
  }
  return { ok: true, amount, balance: (res.value || res).balance, walletAfter: credit.doc?.totalCoins };
}

module.exports = {
  cfg,
  pendingInterest,
  getAccount,
  settle,
  view,
  deposit,
  withdraw,
};
