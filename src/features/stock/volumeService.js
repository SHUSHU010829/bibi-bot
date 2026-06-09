// 股票成交量聚合 + 記憶體快取。
// 提供兩個查詢：
//   getDailyVolume({ guildId, symbol })      → 當日（Asia/Taipei 00:00 起）買 / 賣股數
//   getBucketedVolume({ guildId, symbol, period }) → 走勢圖期間內每個 bucket 的買 / 賣量
//
// 快取 TTL 5 分鐘，key = `${guildId}|${symbol}|${kind}`，過期才打 DB。

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCache(key, value) {
  cache.set(key, { at: Date.now(), value });
}

// 取得 Asia/Taipei 當日 00:00 的 UTC Date
function taipeiStartOfDay(now = new Date()) {
  const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const taipeiNowMs = now.getTime() + TZ_OFFSET_MS;
  const dayStartTaipeiMs = Math.floor(taipeiNowMs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
  return new Date(dayStartTaipeiMs - TZ_OFFSET_MS);
}

async function getDailyVolume(client, { guildId, symbol }) {
  const key = `${guildId}|${symbol}|daily`;
  const cached = getCache(key);
  if (cached) return cached;

  const since = taipeiStartOfDay();
  const rows = await client.stockTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          symbol,
          side: { $in: ["buy", "sell"] },
          timestamp: { $gte: since },
        },
      },
      {
        $group: {
          _id: "$side",
          shares: { $sum: "$shares" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  let buyShares = 0;
  let sellShares = 0;
  let buyCount = 0;
  let sellCount = 0;
  for (const r of rows) {
    if (r._id === "buy") {
      buyShares = r.shares || 0;
      buyCount = r.count || 0;
    } else if (r._id === "sell") {
      sellShares = r.shares || 0;
      sellCount = r.count || 0;
    }
  }

  const value = {
    buyShares,
    sellShares,
    totalShares: buyShares + sellShares,
    buyCount,
    sellCount,
    totalCount: buyCount + sellCount,
    since,
  };
  setCache(key, value);
  return value;
}

// 把走勢期間切成 N 個 bucket，每格輸出買 / 賣股數。
// period: "1d" → 24 格（每小時），"1w" → 7 格（每天），"1m" → 30 格（每天）。
const BUCKET_CONFIG = {
  "1d": { count: 24, sizeMs: 60 * 60 * 1000 },
  "1w": { count: 7, sizeMs: 24 * 60 * 60 * 1000 },
  "1m": { count: 30, sizeMs: 24 * 60 * 60 * 1000 },
};

async function getBucketedVolume(client, { guildId, symbol, period }) {
  const cfg = BUCKET_CONFIG[period] || BUCKET_CONFIG["1w"];
  const key = `${guildId}|${symbol}|bucket_${period}`;
  const cached = getCache(key);
  if (cached) return cached;

  const totalMs = cfg.count * cfg.sizeMs;
  const since = new Date(Date.now() - totalMs);
  const rows = await client.stockTransactionsCollection
    .find(
      {
        guildId,
        symbol,
        side: { $in: ["buy", "sell"] },
        timestamp: { $gte: since },
      },
      { projection: { side: 1, shares: 1, timestamp: 1 } },
    )
    .toArray();

  const buckets = Array.from({ length: cfg.count }, (_, i) => ({
    index: i,
    start: new Date(since.getTime() + i * cfg.sizeMs),
    buyShares: 0,
    sellShares: 0,
  }));

  for (const r of rows) {
    const idx = Math.floor((r.timestamp.getTime() - since.getTime()) / cfg.sizeMs);
    if (idx < 0 || idx >= cfg.count) continue;
    if (r.side === "buy") buckets[idx].buyShares += r.shares || 0;
    else if (r.side === "sell") buckets[idx].sellShares += r.shares || 0;
  }

  const value = { buckets, since, period };
  setCache(key, value);
  return value;
}

// 給呼叫者主動把某 symbol 的快取打掉（例如剛成交時），確保下次查到最新。
function invalidate({ guildId, symbol }) {
  if (!guildId || !symbol) return;
  const prefix = `${guildId}|${symbol}|`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

module.exports = {
  getDailyVolume,
  getBucketedVolume,
  invalidate,
};
