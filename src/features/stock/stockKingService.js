// 最強操盤手（stock_king）歷屆頒發紀錄。
//
// 每週一結算頒發稱號時寫一筆 StockKingHistory（guildId + weekStart 唯一），
// 之後 /股市 名人堂 直接讀這份紀錄，不必再重算歷史成交。
// 功能上線前的舊週次沒有紀錄，查詢時會依既有 StockTransactions 追溯補寫
// （source = "backfill"），並在畫面上標示為追溯，避免看起來像當時真的頒過。

const { DateTime } = require("luxon");

const { stockSystem } = require("../../config");
const leaderboardService = require("./leaderboardService");

const TZ = stockSystem?.leaderboard?.timezone || stockSystem?.timezone || "Asia/Taipei";
// StockTransactions 只保留 90 天（TTL），再往前追溯也算不出正確冠軍
const BACKFILL_WEEKS = 12;
// 追溯過但週數仍不足（新伺服器）時，避免每次查詢都重掃一輪成交
const BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const lastBackfillAt = new Map();

function titleId() {
  return stockSystem?.leaderboard?.titleId || "stock_king";
}

// weeksAgo = 1 → 上一個完整週（與 leaderboardService.previousWeekWindow 對齊）。
function weekWindow(weeksAgo) {
  const start = DateTime.now().setZone(TZ).startOf("week").minus({ weeks: weeksAgo });
  return { start: start.toJSDate(), end: start.plus({ weeks: 1 }).toJSDate() };
}

function weekLabel(weekStart) {
  const start = DateTime.fromJSDate(new Date(weekStart)).setZone(TZ);
  const end = start.plus({ days: 6 });
  return `${start.toFormat("M/d")}–${end.toFormat("M/d")}`;
}

async function recordAward(
  client,
  { guildId, window, ranking, dethroned = [], source = "weekly_cron" }
) {
  if (!client.stockKingHistoryCollection || !ranking?.length) return null;
  const winner = ranking[0];
  const doc = {
    guildId,
    titleId: titleId(),
    userId: winner.userId,
    weekStart: new Date(window.start),
    weekEnd: new Date(window.end),
    pnl: winner.pnl,
    trades: winner.trades,
    top: ranking.slice(0, 3).map((r) => ({ userId: r.userId, pnl: r.pnl, trades: r.trades })),
    dethroned,
    source,
    updatedAt: new Date(),
  };
  await client.stockKingHistoryCollection
    .updateOne(
      { guildId, weekStart: doc.weekStart },
      { $set: doc, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    )
    .catch(() => {});
  return doc;
}

async function storedHistory(client, guildId, limit) {
  return client.stockKingHistoryCollection
    .find({ guildId })
    .sort({ weekStart: -1 })
    .limit(limit)
    .toArray()
    .catch(() => []);
}

// 對還沒有紀錄的舊週次重算冠軍並補寫（只補到湊滿 limit 筆為止）。
async function backfill(client, guildId, { limit, known }) {
  const added = [];
  const hasTrades = await client.stockTransactionsCollection
    ?.findOne({ guildId }, { projection: { _id: 1 } })
    .catch(() => null);
  if (!hasTrades) return added;
  // weeksAgo = 1 是週結算負責的那一週：留給排程（含補跑）去頒稱號 + 公告，
  // 這裡先補寫的話會讓結算誤判成「已經結算過」而不再頒發。
  for (let weeksAgo = 2; weeksAgo <= BACKFILL_WEEKS; weeksAgo += 1) {
    if (known.size + added.length >= limit) break;
    const window = weekWindow(weeksAgo);
    if (known.has(window.start.getTime())) continue;
    const ranking = await leaderboardService.rankByWindow(client, guildId, {
      ...window,
      limit: stockSystem?.leaderboard?.topN || 10,
    });
    // 與週結算同一條規則：冠軍虧錢就不算頒過
    if (!ranking.length || ranking[0].pnl <= 0) continue;
    const doc = await recordAward(client, { guildId, window, ranking, source: "backfill" });
    if (doc) added.push(doc);
  }
  return added;
}

// 歷屆冠軍（新到舊）。舊週次不足時自動追溯補寫。
async function history(client, guildId, { limit = 8 } = {}) {
  if (!client.stockKingHistoryCollection) return [];
  const stored = await storedHistory(client, guildId, limit);
  if (stored.length >= limit) return stored;

  if (Date.now() - (lastBackfillAt.get(guildId) || 0) < BACKFILL_COOLDOWN_MS) return stored;
  lastBackfillAt.set(guildId, Date.now());

  const known = new Set(stored.map((d) => new Date(d.weekStart).getTime()));
  await backfill(client, guildId, { limit, known });
  return storedHistory(client, guildId, limit);
}

// 各玩家的封王次數（新到舊排序後取前 limit 名）。
async function reignCounts(client, guildId, limit = 5) {
  if (!client.stockKingHistoryCollection) return [];
  const rows = await client.stockKingHistoryCollection
    .aggregate([
      { $match: { guildId } },
      {
        $group: {
          _id: "$userId",
          reigns: { $sum: 1 },
          bestPnl: { $max: "$pnl" },
          lastWeek: { $max: "$weekStart" },
        },
      },
      { $sort: { reigns: -1, bestPnl: -1 } },
      { $limit: limit },
    ])
    .toArray()
    .catch(() => []);
  return rows.map((r) => ({
    userId: r._id,
    reigns: r.reigns,
    bestPnl: r.bestPnl || 0,
    lastWeek: r.lastWeek,
  }));
}

async function myReigns(client, guildId, userId) {
  if (!client.stockKingHistoryCollection) return { reigns: 0, lastWeek: null };
  const rows = await client.stockKingHistoryCollection
    .find({ guildId, userId })
    .sort({ weekStart: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  const reigns = await client.stockKingHistoryCollection
    .countDocuments({ guildId, userId })
    .catch(() => 0);
  return { reigns, lastWeek: rows[0]?.weekStart || null };
}

// 目前持有稱號的玩家（可能因手動授予而多於一人）。
async function currentHolders(client, guildId) {
  if (!client.userLevelsCollection) return [];
  const rows = await client.userLevelsCollection
    .find({ guildId, gameTitles: titleId() })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  return rows.map((r) => r.userId);
}

module.exports = {
  titleId,
  weekWindow,
  weekLabel,
  recordAward,
  history,
  reignCounts,
  myReigns,
  currentHolders,
};
