require("colors");
const crypto = require("crypto");
const { bank } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const orePriceEngine = require("../market/orePriceEngine");
const creditService = require("./creditService");

// 黃金存摺：現貨價沿用「黃金礦」每日浮動價（全服同一金價），
// 銀行買進/賣出各收一段價差（spread）。金庫持有量以「單位（克）」記，
// 1 黃金礦 = 1 單位，可熔進金庫；不動用錢包，錢包只在買/賣時進出。

function cfg() {
  return bank?.gold || {};
}

async function getPrices(client) {
  const spotOre = cfg().spotOre || "gold";
  const spot = await orePriceEngine.getOrePrice(client, spotOre);
  const buySpread = cfg().buySpread ?? 0.03;
  const sellSpread = cfg().sellSpread ?? 0.03;
  return {
    spot,
    buy: Math.max(1, Math.round(spot * (1 + buySpread))),
    sell: Math.max(1, Math.round(spot * (1 - sellSpread))),
    date: orePriceEngine.todayDate(),
  };
}

async function getHolding(client, userId, guildId) {
  const col = client.goldHoldingsCollection;
  if (!col) return 0;
  const doc = await col.findOne({ userId, guildId }).catch(() => null);
  return doc?.units || 0;
}

async function addHolding(client, userId, guildId, delta) {
  const col = client.goldHoldingsCollection;
  const now = new Date();
  const res = await col.findOneAndUpdate(
    { userId, guildId },
    {
      $inc: { units: delta },
      $setOnInsert: { userId, guildId, createdAt: now },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  return (res.value || res)?.units || 0;
}

// 有條件扣減：庫存足夠才扣，避免並發把庫存扣成負數（憑空變幣）。回傳是否成功。
async function tryDeduct(client, userId, guildId, units) {
  const res = await client.goldHoldingsCollection.findOneAndUpdate(
    { userId, guildId, units: { $gte: units } },
    { $inc: { units: -units }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const doc = res.value || res;
  return doc ? { ok: true, holding: doc.units } : { ok: false };
}

// 買進黃金：扣錢包、加金庫。回傳 { ok, reason, ... }。
async function buy(client, { userId, guildId, username, member, avatarHash, units }) {
  const c = cfg();
  const min = c.minTradeUnits ?? 1;
  const max = c.maxTradeUnits ?? 2000;
  if (units < min || units > max) {
    return { ok: false, reason: "range", min, max };
  }
  const prices = await getPrices(client);
  const cost = units * prices.buy;
  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = before?.totalCoins || 0;
  if (balance < cost) {
    return { ok: false, reason: "balance", cost, balance, prices };
  }
  const debit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: -cost,
    source: "gold_buy",
    member,
    meta: { units, unitPrice: prices.buy },
  });
  if (!debit) return { ok: false, reason: "debit" };
  const holding = await addHolding(client, userId, guildId, units);
  creditService.award(client, userId, guildId, "gold_trade", { member }).catch(() => {});
  return { ok: true, units, cost, prices, holding, balanceAfter: debit.doc?.totalCoins ?? balance - cost };
}

// 賣出黃金：扣金庫、加錢包。
async function sell(client, { userId, guildId, username, member, avatarHash, units }) {
  const c = cfg();
  const min = c.minTradeUnits ?? 1;
  const holding = await getHolding(client, userId, guildId);
  if (units < min) return { ok: false, reason: "min", min };
  if (holding < units) return { ok: false, reason: "holding", holding };

  const prices = await getPrices(client);
  const gain = units * prices.sell;
  const deducted = await tryDeduct(client, userId, guildId, units);
  if (!deducted.ok) return { ok: false, reason: "holding", holding };
  const credit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: gain,
    source: "gold_sell",
    member,
    meta: { units, unitPrice: prices.sell },
  });
  if (!credit) {
    await addHolding(client, userId, guildId, units); // 回滾金庫
    return { ok: false, reason: "credit" };
  }
  creditService.award(client, userId, guildId, "gold_trade", { member }).catch(() => {});
  return { ok: true, units, gain, prices, holding: deducted.holding, balanceAfter: credit.doc?.totalCoins };
}

// 熔金：把挖礦背包的黃金礦轉進金庫（不動錢包）。
async function refine(client, { userId, guildId, oreQty }) {
  const c = cfg().refine || {};
  if (!c.enabled) return { ok: false, reason: "disabled" };
  const oreKey = c.oreKey || "gold";
  const perOre = c.unitsPerOre ?? 1;
  const col = client.miningProfilesCollection;
  if (!col) return { ok: false, reason: "no_mining" };

  const owned = await col.findOne({ userId, guildId }).catch(() => null);
  const have = owned?.backpack?.[oreKey] || 0;
  if (have < oreQty) return { ok: false, reason: "ore", have, oreKey };

  const upd = await col.updateOne(
    { userId, guildId, [`backpack.${oreKey}`]: { $gte: oreQty } },
    { $inc: { [`backpack.${oreKey}`]: -oreQty } },
  );
  if (!upd.modifiedCount) return { ok: false, reason: "ore", have, oreKey };

  const units = oreQty * perOre;
  const holding = await addHolding(client, userId, guildId, units);
  return { ok: true, oreQty, units, holding };
}

// ── 黃金定存 ────────────────────────────────────────────────────────────────
function termCfg() {
  return cfg().term || {};
}

function findTerm(days) {
  return (termCfg().terms || []).find((t) => t.days === days) || null;
}

async function openTerm(client, { userId, guildId, member, units, days }) {
  const tc = termCfg();
  if (!tc.enabled) return { ok: false, reason: "disabled" };
  const minUnits = tc.minUnits ?? 1;
  if (units < minUnits) return { ok: false, reason: "min", minUnits };
  const term = findTerm(days);
  if (!term) return { ok: false, reason: "term" };

  const maxActive = tc.maxActivePerUser ?? 5;
  const active = await client.goldDepositsCollection.countDocuments({ userId, guildId, status: "active" });
  if (active >= maxActive) return { ok: false, reason: "slots", maxActive, active };

  const holding = await getHolding(client, userId, guildId);
  if (holding < units) return { ok: false, reason: "holding", holding };

  const deducted = await tryDeduct(client, userId, guildId, units);
  if (!deducted.ok) return { ok: false, reason: "holding", holding };
  const depositId = `gld_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date();
  const maturesAt = new Date(now.getTime() + days * 86400000);
  const interestUnits = Math.floor(units * term.rate);
  await client.goldDepositsCollection.insertOne({
    depositId,
    userId,
    guildId,
    units,
    days,
    rate: term.rate,
    interestUnits,
    status: "active",
    createdAt: now,
    maturesAt,
  });
  return { ok: true, depositId, units, days, rate: term.rate, interestUnits, maturesAt };
}

async function listTerms(client, userId, guildId) {
  return client.goldDepositsCollection
    .find({ userId, guildId, status: "active" })
    .sort({ maturesAt: 1 })
    .limit(20)
    .toArray();
}

async function claimTerm(client, { userId, guildId, member, depositId }) {
  const doc = await client.goldDepositsCollection.findOne({ depositId, userId, guildId });
  if (!doc) return { ok: false, reason: "notfound" };
  if (doc.status !== "active") return { ok: false, reason: "claimed" };

  const now = new Date();
  const matured = new Date(doc.maturesAt).getTime() <= now.getTime();
  let payoutUnits;
  let penaltyUnits = 0;
  if (matured) {
    payoutUnits = doc.units + doc.interestUnits;
  } else {
    const penaltyRate = termCfg().earlyWithdrawPenaltyRate ?? 0.15;
    penaltyUnits = Math.floor(doc.units * penaltyRate);
    payoutUnits = Math.max(0, doc.units - penaltyUnits);
  }

  const upd = await client.goldDepositsCollection.findOneAndUpdate(
    { depositId, userId, guildId, status: "active" },
    { $set: { status: matured ? "claimed" : "early_claimed", claimedAt: now, payoutUnits, penaltyUnits } },
    { returnDocument: "after" },
  );
  if (!(upd.value || upd)) return { ok: false, reason: "race" };

  const holding = await addHolding(client, userId, guildId, payoutUnits);
  if (matured) {
    creditService.award(client, userId, guildId, "deposit_matured", { member }).catch(() => {});
  }
  return { ok: true, matured, payoutUnits, penaltyUnits, holding, units: doc.units, interestUnits: doc.interestUnits };
}

module.exports = {
  cfg,
  termCfg,
  findTerm,
  getPrices,
  getHolding,
  addHolding,
  buy,
  sell,
  refine,
  openTerm,
  listTerms,
  claimTerm,
};
