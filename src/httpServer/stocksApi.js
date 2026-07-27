const express = require("express");
const { stockSystem } = require("../config");

// 供 Dashboard（bibi-website）讀取的股市唯讀 API。
// 網站部署在 Vercel、連不到 bot 所在 Vultr 的內網 Mongo，故一律走這裡由 bot
// 從本機 Mongo 平讀後回傳 JSON（與排行榜 API 同一條路，Mongo 不對外開）。
// 彙總邏輯與原本 bibi-website src/lib/dashboard/stocks.ts 一致，只是資料源換成
// client.stock*Collection。

const PERIOD_MS = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

// 分桶大小：1小時→每3分、1天→每30分、1週/1月→每天。K 線與量柱共用同一組桶。
const BUCKET_MS = {
  "1h": 3 * 60 * 1000,
  "1d": 30 * 60 * 1000,
  "1w": 24 * 60 * 60 * 1000,
  "1m": 24 * 60 * 60 * 1000,
};

const LINE_MAX_POINTS = 240;
const VALID_PERIODS = ["1h", "1d", "1w", "1m"];

// symbol → 型別（tech / blue / meme）：現役 + 候補 pool 為單一來源。
function buildTypeMap() {
  const map = new Map();
  for (const p of [...(stockSystem?.pool || []), ...(stockSystem?.candidatePool || [])]) {
    if (p?.symbol && !map.has(p.symbol)) map.set(p.symbol, p.type || "");
  }
  return map;
}

// 依 config pool 的順序排（找不到的排後面），讓清單順序穩定。
function buildOrder() {
  const order = [];
  for (const p of [...(stockSystem?.pool || []), ...(stockSystem?.candidatePool || [])]) {
    if (p?.symbol && !order.includes(p.symbol)) order.push(p.symbol);
  }
  return order;
}

function sampleLine(points) {
  if (points.length <= LINE_MAX_POINTS) return points;
  const step = Math.ceil(points.length / LINE_MAX_POINTS);
  const out = points.filter((_, i) => i % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1]?.t !== last.t) out.push(last);
  return out;
}

function buildCandles(points, bucketMs) {
  const byBucket = new Map();
  for (const pt of points) {
    const key = Math.floor(pt.t / bucketMs) * bucketMs;
    const arr = byBucket.get(key);
    if (arr) arr.push(pt);
    else byBucket.set(key, [pt]);
  }
  const keys = [...byBucket.keys()].sort((a, b) => a - b);
  return keys.map((key) => {
    const prices = byBucket.get(key).map((p) => p.p);
    return {
      t: key,
      o: prices[0],
      h: Math.max(...prices),
      l: Math.min(...prices),
      c: prices[prices.length - 1],
    };
  });
}

async function buildVolume(client, guildId, symbol, since, bucketMs) {
  if (!client.stockTransactionsCollection) return [];
  const rows = await client.stockTransactionsCollection
    .find(
      {
        guildId,
        symbol,
        side: { $in: ["buy", "sell"] },
        timestamp: { $gte: new Date(since) },
      },
      { projection: { side: 1, shares: 1, timestamp: 1 } },
    )
    .toArray();

  const byBucket = new Map();
  for (const r of rows) {
    const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : Number(r.timestamp);
    if (!Number.isFinite(ts)) continue;
    const key = Math.floor(ts / bucketMs) * bucketMs;
    let bar = byBucket.get(key);
    if (!bar) {
      bar = { t: key, buy: 0, sell: 0 };
      byBucket.set(key, bar);
    }
    const shares = Number(r.shares ?? 0);
    if (r.side === "buy") bar.buy += shares;
    else bar.sell += shares;
  }
  return [...byBucket.values()].sort((a, b) => a.t - b.t);
}

async function getQuotes(client, guildId) {
  if (!client.stockMarketCollection) return [];
  const docs = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false } })
    .toArray();
  const typeMap = buildTypeMap();

  const quotes = docs.map((d) => {
    const symbol = String(d.symbol ?? "");
    const price = Number(d.currentPrice ?? 0);
    const open = Number(d.openPrice ?? price) || price;
    const change = price - open;
    return {
      symbol,
      name: String(d.name ?? symbol),
      type: typeMap.get(symbol) ?? "",
      price,
      open,
      change,
      changePct: open > 0 ? (change / open) * 100 : 0,
      floor: Number(d.floor ?? 0),
      sentiment: String(d.marketSentiment ?? "sideways"),
    };
  });

  const order = buildOrder();
  quotes.sort((a, b) => {
    const ia = order.indexOf(a.symbol);
    const ib = order.indexOf(b.symbol);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return quotes;
}

async function getSeries(client, guildId, symbol, period) {
  if (!client.stockMarketCollection) return null;
  const market = await client.stockMarketCollection.findOne({ guildId, symbol });
  if (!market) return null;

  const now = Date.now();
  const bucketMs = BUCKET_MS[period];
  const since = now - PERIOD_MS[period];

  const raw = await client.stockPricesCollection
    .find(
      { guildId, symbol, timestamp: { $gte: new Date(since) } },
      { projection: { price: 1, timestamp: 1 } },
    )
    .sort({ timestamp: 1 })
    .toArray();

  const points = raw
    .map((r) => {
      const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : Number(r.timestamp);
      return { t: ts, p: Number(r.price ?? 0) };
    })
    .filter((pt) => Number.isFinite(pt.t) && pt.p > 0);

  const candles = buildCandles(points, bucketMs);
  const volume = await buildVolume(client, guildId, symbol, since, bucketMs);

  let stat = null;
  if (points.length > 0) {
    const prices = points.map((p) => p.p);
    const open = prices[0];
    const last = prices[prices.length - 1];
    stat = {
      open,
      last,
      high: Math.max(...prices),
      low: Math.min(...prices),
      changePct: open > 0 ? ((last - open) / open) * 100 : 0,
    };
  }

  return {
    symbol,
    period,
    since,
    now,
    bucketMs,
    points: sampleLine(points),
    candles,
    volume,
    stat,
  };
}

module.exports = function createStocksRouter(client) {
  const router = express.Router();

  function requireGuild(req, res) {
    const guildId = req.query.guildId;
    if (!guildId) {
      res.status(400).json({ error: "missing guildId" });
      return null;
    }
    return String(guildId);
  }

  // GET /api/v1/stocks/quotes?guildId=
  router.get("/quotes", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      res.json({ ok: true, quotes: await getQuotes(client, guildId) });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/stocks/series?guildId=&symbol=&period=1d
  router.get("/series", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      const symbol = req.query.symbol ? String(req.query.symbol) : null;
      if (!symbol) {
        res.status(400).json({ error: "missing symbol" });
        return;
      }
      let period = String(req.query.period || "1d");
      if (!VALID_PERIODS.includes(period)) period = "1d";
      res.json({ ok: true, series: await getSeries(client, guildId, symbol, period) });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
