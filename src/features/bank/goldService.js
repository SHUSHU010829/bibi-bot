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

// 加庫存並累計成本：unitCost = 每克入庫成本（買進價 / 精煉現貨價 / 定存還原成本）。
// 平均成本採「移動平均」：只存來源（units 總量 + costBasis 總成本），均價與損益都讀取時才算。
async function addHolding(client, userId, guildId, delta, unitCost = 0) {
  const col = client.goldHoldingsCollection;
  const now = new Date();
  const inc = { units: delta };
  if (delta > 0 && unitCost > 0) inc.costBasis = Math.round(delta * unitCost);
  const res = await col.findOneAndUpdate(
    { userId, guildId },
    {
      $inc: inc,
      $setOnInsert: { userId, guildId, createdAt: now },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  return (res.value || res)?.units || 0;
}

// 有條件扣減：庫存足夠才扣，避免並發把庫存扣成負數（憑空變幣）。
// 同步按均價扣掉對應成本（costBasis），回傳被扣掉的成本 removedCost 供顯示損益 / 回滾。
async function tryDeduct(client, userId, guildId, units) {
  const col = client.goldHoldingsCollection;
  const doc = await col.findOne({ userId, guildId }).catch(() => null);
  const have = doc?.units || 0;
  if (have < units) return { ok: false };
  const costBasis = doc?.costBasis || 0;
  const avgCost = have > 0 ? costBasis / have : 0;
  const removedCost = Math.round(avgCost * units);
  const res = await col.findOneAndUpdate(
    { userId, guildId, units: { $gte: units } },
    { $inc: { units: -units, costBasis: -removedCost }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const updated = res.value || res;
  if (!updated) return { ok: false };
  // 全數賣光後成本歸零，避免比例四捨五入的殘值長期累積。
  if (updated.units <= 0 && (updated.costBasis || 0) !== 0) {
    await col.updateOne({ userId, guildId }, { $set: { costBasis: 0 } }).catch(() => {});
    updated.costBasis = 0;
  }
  return { ok: true, holding: updated.units, removedCost, avgCost };
}

// ── 金庫容量 ────────────────────────────────────────────────────────────────
// 金庫存量有上限，純金不能無限囤：放不下的財富只能留在錢包，照樣被每週財富稅課到。
// 容量＝基礎容量＋信用評等加成，讀取時即時算（compute-on-read，不寫進 DB）。
function vaultCfg() {
  return cfg().vault || {};
}

async function getCapacity(client, userId, guildId, member) {
  const v = vaultCfg();
  if (v.enabled === false) return Infinity;
  const base = v.baseCapacity ?? 200;
  if (!bank?.credit?.enabled) return base;
  const limits = await creditService.getLimits(client, userId, guildId, member);
  return base + (limits.tier?.vaultBonus || 0);
}

// 最高信用評等能開到的容量（文案用，不要在各處寫死數字）。
function maxCapacity() {
  const base = vaultCfg().baseCapacity ?? 200;
  const top = creditService.tiers().at(-1);
  return { capacity: base + (top?.vaultBonus || 0), tier: top };
}

// 定存鎖倉的克數也算佔用容量，否則定存會變成繞過上限的無限倉庫。
async function getLockedUnits(client, userId, guildId) {
  const col = client.goldDepositsCollection;
  if (!col) return 0;
  const rows = await col
    .aggregate([
      { $match: { userId, guildId, status: "active" } },
      { $group: { _id: null, units: { $sum: "$units" } } },
    ])
    .toArray()
    .catch(() => []);
  return rows[0]?.units || 0;
}

async function getVaultStatus(client, userId, guildId, member) {
  const [position, locked, capacity] = await Promise.all([
    getPosition(client, userId, guildId),
    getLockedUnits(client, userId, guildId),
    getCapacity(client, userId, guildId, member),
  ]);
  const used = position.units + locked;
  const free = Number.isFinite(capacity) ? Math.max(0, capacity - used) : Infinity;
  const over = Number.isFinite(capacity) && used > capacity;
  return {
    units: position.units,
    locked,
    used,
    capacity,
    free,
    limited: Number.isFinite(capacity),
    over,
    // 超出的克數裡，鎖在定存的那部分只能等到期（claimTerm 會自動折現），現在賣不掉。
    overUnits: over ? used - capacity : 0,
    overSellable: over ? Math.min(used - capacity, position.units) : 0,
    graceDeadline: position.overCapDeadline,
  };
}

// 讀取黃金部位：持有量、總成本、移動平均成本。
async function getPosition(client, userId, guildId) {
  const col = client.goldHoldingsCollection;
  if (!col) return { units: 0, costBasis: 0, avgCost: 0 };
  const doc = await col.findOne({ userId, guildId }).catch(() => null);
  const units = doc?.units || 0;
  const costBasis = doc?.costBasis || 0;
  return {
    units,
    costBasis,
    avgCost: units > 0 ? costBasis / units : 0,
    overCapDeadline: doc?.overCapDeadline || null,
  };
}

// 買進黃金：扣錢包、加金庫。回傳 { ok, reason, ... }。
async function buy(client, { userId, guildId, username, member, avatarHash, units }) {
  const c = cfg();
  const min = c.minTradeUnits ?? 1;
  const max = c.maxTradeUnits ?? 2000;
  if (units < min || units > max) {
    return { ok: false, reason: "range", min, max };
  }
  const vault = await getVaultStatus(client, userId, guildId, member);
  if (units > vault.free) {
    return { ok: false, reason: "capacity", vault };
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
  const holding = await addHolding(client, userId, guildId, units, prices.buy);
  const position = await getPosition(client, userId, guildId);
  creditService.award(client, userId, guildId, "gold_trade", { member }).catch(() => {});
  return {
    ok: true,
    units,
    cost,
    prices,
    holding,
    capacity: vault.capacity,
    avgCost: position.avgCost,
    balanceAfter: debit.doc?.totalCoins ?? balance - cost,
  };
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
    // 回滾金庫並還原被扣掉的成本
    await addHolding(client, userId, guildId, units, deducted.removedCost / units);
    return { ok: false, reason: "credit" };
  }
  creditService.award(client, userId, guildId, "gold_trade", { member }).catch(() => {});
  return {
    ok: true,
    units,
    gain,
    prices,
    holding: deducted.holding,
    avgCost: deducted.avgCost,
    costRemoved: deducted.removedCost,
    pnl: gain - deducted.removedCost,
    balanceAfter: credit.doc?.totalCoins,
  };
}

// 超出容量的強制折現（寬限期到期）：扣金庫、按當日賣出價入錢包。
// 走 gold_overflow 記帳，與「黃金定存到期塞不下」同一個來源，玩家看得到是被折現而非賣出。
async function liquidate(client, { userId, guildId, username, avatarHash, member, units, reason }) {
  if (units < 1) return { ok: false, reason: "min" };
  const deducted = await tryDeduct(client, userId, guildId, units);
  if (!deducted.ok) return { ok: false, reason: "holding" };

  const prices = await getPrices();
  const gain = units * prices.sell;
  const credit = await grantCoins(client, {
    userId,
    guildId,
    username,
    avatarHash,
    amount: gain,
    source: "gold_overflow",
    member,
    meta: { units, unitPrice: prices.sell, reason },
  });
  if (!credit) {
    await addHolding(client, userId, guildId, units, deducted.removedCost / units);
    return { ok: false, reason: "credit" };
  }
  return {
    ok: true,
    units,
    gain,
    prices,
    holding: deducted.holding,
    pnl: gain - deducted.removedCost,
  };
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
async function refine(client, { userId, guildId, member, units }) {
  const r = refineRecipe();
  if (!r.enabled) return { ok: false, reason: "disabled" };
  if (units < 1) return { ok: false, reason: "min" };
  if (units > r.maxBatch) return { ok: false, reason: "max", maxBatch: r.maxBatch };
  const col = client.miningProfilesCollection;
  if (!col) return { ok: false, reason: "no_mining" };

  const vault = await getVaultStatus(client, userId, guildId, member);
  if (units > vault.free) return { ok: false, reason: "capacity", vault };

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

  // 精煉入庫的成本以當日現貨價計（原料換算的公允市值），使平均成本貼近市場。
  const holding = await addHolding(client, userId, guildId, units, spotPrice());
  return { ok: true, units, needOre, needCoal, r, holding, capacity: vault.capacity };
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
    costBasis: deducted.removedCost, // 鎖倉時帶走的成本，領回時原樣還原
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

async function claimTerm(client, { userId, guildId, username, avatarHash, member, depositId }) {
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

  // 還原鎖倉時帶走的成本：到期＝本金成本原樣（利息為免費金，稀釋均價）；
  // 提前解約＝按實領比例還原成本。
  const origCost = doc.costBasis || 0;
  let restoreUnitCost = 0;
  if (payoutUnits > 0) {
    restoreUnitCost = matured ? origCost / payoutUnits : doc.units > 0 ? origCost / doc.units : 0;
  }

  // 鎖倉解除後才算容量（這筆的克數已不佔用）；金庫塞不下的部分按賣出價折現進錢包，
  // 錢不會憑空消失，但會回到「會被財富稅課到」的錢包，而不是繼續囤在免稅的金庫裡。
  const vault = await getVaultStatus(client, userId, guildId, member);
  const storedUnits = Math.min(payoutUnits, vault.free);
  const overflowUnits = payoutUnits - storedUnits;
  const holding =
    storedUnits > 0
      ? await addHolding(client, userId, guildId, storedUnits, restoreUnitCost)
      : vault.units;

  let overflowGain = 0;
  if (overflowUnits > 0) {
    const prices = await getPrices();
    overflowGain = overflowUnits * prices.sell;
    await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash,
      amount: overflowGain,
      source: "gold_overflow",
      member,
      meta: { depositId, units: overflowUnits, unitPrice: prices.sell, capacity: vault.capacity },
    });
  }

  if (matured) {
    creditService.award(client, userId, guildId, "deposit_matured", { member }).catch(() => {});
  }
  return {
    ok: true,
    matured,
    payoutUnits,
    penaltyUnits,
    holding,
    storedUnits,
    overflowUnits,
    overflowGain,
    capacity: vault.capacity,
    units: doc.units,
    interestUnits: doc.interestUnits,
  };
}

module.exports = {
  cfg,
  vaultCfg,
  termCfg,
  findTerm,
  spotPrice,
  getPrices,
  getHolding,
  getPosition,
  getCapacity,
  maxCapacity,
  getLockedUnits,
  getVaultStatus,
  addHolding,
  liquidate,
  refineRecipe,
  buy,
  sell,
  refine,
  openTerm,
  listTerms,
  claimTerm,
};
