require("colors");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { bank, coinSystem } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const creditService = require("./creditService");
const loanService = require("./loanService");

// 黃金存摺（純金）：純金是高單價貴金屬，價格獨立於便宜的黃金礦，每日 seeded 浮動、全服一致。
// 純金無法直接把礦丟進來，必須用「黃金礦 + 煤炭（燃料）精煉」才能入庫（見 refine）。
// 金庫持有量以「克」記；買/賣才動用錢包，精煉只消耗挖礦原料。

function cfg() {
  return bank?.gold || {};
}

function timezone() {
  return coinSystem?.daily?.resetTimezone || "Asia/Taipei";
}

function todayDate() {
  return DateTime.now().setZone(timezone()).toFormat("yyyyMMdd");
}

function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 純金每日現貨價：由日期 seed 決定，同一天全服固定。
function spotPrice(dateStr = todayDate()) {
  const c = cfg();
  const base = c.basePrice ?? 3000;
  const min = typeof c.minFactor === "number" ? c.minFactor : 0.75;
  const max = typeof c.maxFactor === "number" ? c.maxFactor : 1.25;
  const dateInt = parseInt(dateStr, 10) || 0;
  const rng = mulberry32((dateInt ^ hashStr("bank_gold")) >>> 0);
  const factor = min + rng() * (max - min);
  return Math.max(1, Math.round(base * factor));
}

async function getPrices() {
  const spot = spotPrice();
  const buySpread = cfg().buySpread ?? 0.04;
  const sellSpread = cfg().sellSpread ?? 0.04;
  return {
    spot,
    buy: Math.max(1, Math.round(spot * (1 + buySpread))),
    sell: Math.max(1, Math.round(spot * (1 - sellSpread))),
    date: todayDate(),
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

function refineRecipe() {
  const c = cfg().refine || {};
  return {
    enabled: !!c.enabled,
    oreKey: c.oreKey || "gold",
    orePerUnit: c.orePerUnit ?? 5,
    coalKey: c.coalKey || "coal",
    coalPerUnit: c.coalPerUnit ?? 0,
    maxBatch: c.maxBatch ?? 100,
  };
}

// 精煉：用黃金礦 + 煤炭（燃料）煉出 units 克純金存進金庫（不動錢包）。
// units = 要煉出的克數；每克消耗 orePerUnit 黃金礦 + coalPerUnit 煤炭。
async function refine(client, { userId, guildId, units }) {
  const r = refineRecipe();
  if (!r.enabled) return { ok: false, reason: "disabled" };
  if (units < 1) return { ok: false, reason: "min" };
  if (units > r.maxBatch) return { ok: false, reason: "max", maxBatch: r.maxBatch };
  const col = client.miningProfilesCollection;
  if (!col) return { ok: false, reason: "no_mining" };

  const needOre = units * r.orePerUnit;
  const needCoal = units * r.coalPerUnit;
  const owned = await col.findOne({ userId, guildId }).catch(() => null);
  const haveOre = owned?.backpack?.[r.oreKey] || 0;
  const haveCoal = owned?.backpack?.[r.coalKey] || 0;
  if (haveOre < needOre) {
    return { ok: false, reason: "ore", haveOre, needOre, r };
  }
  if (r.coalPerUnit > 0 && haveCoal < needCoal) {
    return { ok: false, reason: "coal", haveCoal, needCoal, r };
  }

  const filter = { userId, guildId, [`backpack.${r.oreKey}`]: { $gte: needOre } };
  const dec = { [`backpack.${r.oreKey}`]: -needOre };
  if (r.coalPerUnit > 0) {
    filter[`backpack.${r.coalKey}`] = { $gte: needCoal };
    dec[`backpack.${r.coalKey}`] = -needCoal;
  }
  const upd = await col.updateOne(filter, { $inc: dec });
  if (!upd.modifiedCount) return { ok: false, reason: "ore", haveOre, needOre, r };

  const holding = await addHolding(client, userId, guildId, units);
  return { ok: true, units, needOre, needCoal, r, holding };
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
  const block = await loanService.repaymentBlock(client, userId, guildId);
  if (block) return { ok: false, reason: "loan_frozen", block };

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
  spotPrice,
  getPrices,
  getHolding,
  addHolding,
  refineRecipe,
  buy,
  sell,
  refine,
  openTerm,
  listTerms,
  claimTerm,
};
