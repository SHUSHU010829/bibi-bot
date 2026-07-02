const { DateTime } = require("luxon");
const { stockSystem } = require("../../config");

const TZ = stockSystem?.leaderboard?.timezone || stockSystem?.timezone || "Asia/Taipei";

// 已實現損益榜：把賣出（sell）與融券回補（short_cover）的 pnl 依玩家加總。
// luxon 的 week 以週一為首，回傳 JS Date。
function currentWeekWindow() {
  const start = DateTime.now().setZone(TZ).startOf("week");
  return { start: start.toJSDate(), end: start.plus({ weeks: 1 }).toJSDate() };
}

function previousWeekWindow() {
  const thisStart = DateTime.now().setZone(TZ).startOf("week");
  return {
    start: thisStart.minus({ weeks: 1 }).toJSDate(),
    end: thisStart.toJSDate(),
  };
}

function rollingWindow(days) {
  const now = DateTime.now().setZone(TZ);
  return { start: now.minus({ days }).toJSDate(), end: now.plus({ minutes: 1 }).toJSDate() };
}

// 依 [start, end) 區間內已實現損益加總排序（由多到少）。
async function rankByWindow(client, guildId, { start, end, limit = 10 }) {
  if (!client?.stockTransactionsCollection) return [];
  const rows = await client.stockTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          side: { $in: ["sell", "short_cover"] },
          timestamp: { $gte: start, $lt: end },
        },
      },
      {
        $group: {
          _id: "$userId",
          pnl: { $sum: "$pnl" },
          trades: { $sum: 1 },
        },
      },
      { $sort: { pnl: -1, trades: -1 } },
      { $limit: limit },
    ])
    .toArray()
    .catch(() => []);
  return rows.map((r) => ({ userId: r._id, pnl: r.pnl || 0, trades: r.trades || 0 }));
}

async function currentWeekRanking(client, guildId, limit = 10) {
  return rankByWindow(client, guildId, { ...currentWeekWindow(), limit });
}

async function previousWeekRanking(client, guildId, limit = 10) {
  return rankByWindow(client, guildId, { ...previousWeekWindow(), limit });
}

module.exports = {
  currentWeekWindow,
  previousWeekWindow,
  rollingWindow,
  rankByWindow,
  currentWeekRanking,
  previousWeekRanking,
};
