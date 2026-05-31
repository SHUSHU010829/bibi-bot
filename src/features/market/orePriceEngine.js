require("colors");

const { DateTime } = require("luxon");
const { mining, fishing } = require("../../config");

// Phase F — 每日礦石市價波動引擎
//
// 設計重點：
// - 價格由「日期 + 礦石 key」seeded random 決定，全服一致、同一天重算結果不變。
// - 首次讀取當日價格時 freeze 進 OreMarketPrices（凍結當下用的基礎價），
//   之後就算 config 基礎價調整，歷史價格仍維持當天實際使用值，供走勢查詢正確。
// - 沒有 DB（client 未注入 collection）時仍可純函式計算，方便測試與降級。

const DEFAULT_TZ = "Asia/Taipei";

function marketCfg() {
  return (mining && mining.oreMarket) || {};
}

function oreDefs() {
  return (mining && mining.ores) || {};
}

// 穩定字串雜湊（djb2 變體），讓每種礦石有獨立 seed 偏移，
// 不受 ores 物件的鍵順序或數量影響。
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — 由整數 seed 產生確定性 PRNG（回傳 0~1）
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

function timezone() {
  return marketCfg().timezone || DEFAULT_TZ;
}

// 取得指定時區的「今天」字串 YYYYMMDD
function todayDate(tz = timezone()) {
  return DateTime.now().setZone(tz).toFormat("yyyyMMdd");
}

// 由日期字串 + 礦石 key 推導當日浮動係數（預設 0.70 ~ 1.30）
function factorFor(dateStr, oreKey) {
  const cfg = marketCfg();
  const min = typeof cfg.minFactor === "number" ? cfg.minFactor : 0.7;
  const max = typeof cfg.maxFactor === "number" ? cfg.maxFactor : 1.3;
  const dateInt = parseInt(dateStr, 10) || 0;
  const seed = (dateInt ^ hashStr(oreKey)) >>> 0;
  const rng = mulberry32(seed);
  return min + rng() * (max - min);
}

// 計算指定日期所有礦石的收購價（純函式，不碰 DB）
function computePrices(dateStr) {
  const prices = {};
  const factors = {};
  for (const [key, def] of Object.entries(oreDefs())) {
    const base = def.price || 0;
    const factor = factorFor(dateStr, key);
    // 最低保底 1 幣，避免基礎價極低時被四捨五入成 0
    prices[key] = Math.max(1, Math.round(base * factor));
    factors[key] = factor;
  }
  return { prices, factors };
}

// 取得（必要時 freeze）某日的收購價。回傳 { date, prices, factors, persisted }
async function getDailyPrices(client, dateStr = todayDate()) {
  const computed = computePrices(dateStr);
  const col = client && client.oreMarketPricesCollection;
  if (!col) {
    return { date: dateStr, prices: computed.prices, factors: computed.factors, persisted: false };
  }

  const existing = await col.findOne({ date: dateStr }).catch(() => null);
  if (existing && existing.prices) {
    return {
      date: dateStr,
      prices: existing.prices,
      factors: existing.factors || computed.factors,
      persisted: true,
    };
  }

  // 首次讀取 → 凍結當日價格（idempotent，靠 date unique index）
  await col
    .updateOne(
      { date: dateStr },
      {
        $setOnInsert: {
          date: dateStr,
          prices: computed.prices,
          factors: computed.factors,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    )
    .catch((e) => console.log(`[MARKET] freeze 當日價格失敗 date=${dateStr}: ${e.message}`.yellow));

  return { date: dateStr, prices: computed.prices, factors: computed.factors, persisted: true };
}

// 取得單一礦石今日收購價；無 DB 或無紀錄時 fallback 到基礎價。
async function getOrePrice(client, oreKey, dateStr = todayDate()) {
  const def = oreDefs()[oreKey];
  const base = def ? def.price || 0 : 0;
  const { prices } = await getDailyPrices(client, dateStr);
  const price = prices && typeof prices[oreKey] === "number" ? prices[oreKey] : base;
  return price;
}

// 取得某礦石近 N 天價格走勢（由舊到新）。回傳 [{ date, price }]
async function getPriceHistory(client, oreKey, days = 7) {
  const col = client && client.oreMarketPricesCollection;
  if (!col) return [];
  const docs = await col
    .find({})
    .sort({ date: -1 })
    .limit(days)
    .toArray()
    .catch(() => []);
  return docs
    .map((d) => ({ date: d.date, price: d.prices ? d.prices[oreKey] : undefined }))
    .filter((d) => typeof d.price === "number")
    .reverse();
}

// 清掉超過保留天數的歷史價格
async function pruneOld(client, retentionDays = marketCfg().retentionDays || 90) {
  const col = client && client.oreMarketPricesCollection;
  if (!col) return 0;
  const cutoff = DateTime.now()
    .setZone(timezone())
    .minus({ days: retentionDays })
    .toFormat("yyyyMMdd");
  const res = await col.deleteMany({ date: { $lt: cutoff } }).catch(() => null);
  return res ? res.deletedCount || 0 : 0;
}

// ── 魚類市價（Phase S4）─────────────────────────────────────────────────────
// 與礦石使用同一套 seeded random 機制，key 前綴 "fish_" 與礦石隔離。
// 魚價存於同一份 OreMarketPrices document 的 fishPrices / fishFactors 欄位。

function fishDefs() {
  return (fishing && fishing.fish) || {};
}

function computeFishPrices(dateStr) {
  const cfg = marketCfg(); // 沿用礦石的 minFactor / maxFactor 設定
  const min = typeof cfg.minFactor === "number" ? cfg.minFactor : 0.7;
  const max = typeof cfg.maxFactor === "number" ? cfg.maxFactor : 1.3;
  const prices = {};
  const factors = {};
  for (const [key, def] of Object.entries(fishDefs())) {
    const base = def.price || 0;
    const dateInt = parseInt(dateStr, 10) || 0;
    const seed = (dateInt ^ hashStr(`fish_${key}`)) >>> 0;
    const rng = mulberry32(seed);
    const factor = min + rng() * (max - min);
    prices[key] = Math.max(1, Math.round(base * factor));
    factors[key] = factor;
  }
  return { prices, factors };
}

async function getDailyFishPrices(client, dateStr = todayDate()) {
  const computed = computeFishPrices(dateStr);
  const col = client && client.oreMarketPricesCollection;
  if (!col) {
    return { date: dateStr, prices: computed.prices, factors: computed.factors, persisted: false };
  }

  const existing = await col.findOne({ date: dateStr }).catch(() => null);
  if (existing && existing.fishPrices) {
    return {
      date: dateStr,
      prices: existing.fishPrices,
      factors: existing.fishFactors || computed.factors,
      persisted: true,
    };
  }

  // Freeze（與礦石不干擾：fish 用 $set，礦石用 $setOnInsert）
  await col
    .updateOne(
      { date: dateStr },
      {
        $setOnInsert: { date: dateStr, createdAt: new Date() },
        $set: { fishPrices: computed.prices, fishFactors: computed.factors },
      },
      { upsert: true }
    )
    .catch((e) => console.log(`[MARKET] freeze 魚類市價失敗 date=${dateStr}: ${e.message}`.yellow));

  return { date: dateStr, prices: computed.prices, factors: computed.factors, persisted: true };
}

// 取得某魚近 N 天價格走勢（由舊到新）
async function getFishPriceHistory(client, fishKey, days = 7) {
  const col = client && client.oreMarketPricesCollection;
  if (!col) return [];
  const docs = await col
    .find({})
    .sort({ date: -1 })
    .limit(days)
    .toArray()
    .catch(() => []);
  return docs
    .map((d) => ({ date: d.date, price: d.fishPrices ? d.fishPrices[fishKey] : undefined }))
    .filter((d) => typeof d.price === "number")
    .reverse();
}

module.exports = {
  todayDate,
  computePrices,
  computeFishPrices,
  factorFor,
  getDailyPrices,
  getDailyFishPrices,
  getOrePrice,
  getPriceHistory,
  getFishPriceHistory,
  pruneOld,
  timezone,
};
