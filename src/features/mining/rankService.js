const { DateTime } = require("luxon");
const { mining } = require("../../config");

const TZ = mining?.weeklyRank?.timezone || "Asia/Taipei";

// 本週 / 上週的起訖（luxon 的 week 以週一為首）。回傳 JS Date。
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

// 將 period（today / week / month / all）換算成 mineLogs.ts 用的 [start, end) Date 視窗。
function periodWindow(period) {
  const now = DateTime.now().setZone(TZ);
  switch (period) {
    case "today": {
      const start = now.startOf("day");
      return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
    }
    case "month": {
      const start = now.startOf("month");
      return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
    }
    case "all":
      return { start: new Date(0), end: now.plus({ years: 1 }).toJSDate() };
    case "week":
    default:
      return currentWeekWindow();
  }
}

// 依 mineLogs 在 [start, end) 區間內、依 qty 加總每位玩家的挖礦量，由多到少排序。
async function rankByWindow(client, guildId, { start, end, limit = 10 }) {
  if (!client?.mineLogsCollection) return [];
  const rows = await client.mineLogsCollection
    .aggregate([
      { $match: { guild_id: guildId, ts: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: "$user_id",
          total: { $sum: "$qty" },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1, count: -1 } },
      { $limit: limit },
    ])
    .toArray()
    .catch(() => []);
  return rows.map((r) => ({ userId: r._id, total: r.total, count: r.count }));
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
  periodWindow,
  rankByWindow,
  currentWeekRanking,
  previousWeekRanking,
};
