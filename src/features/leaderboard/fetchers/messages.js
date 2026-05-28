const { DateTime } = require("luxon");

function getDateFilter(period) {
  const now = DateTime.now().setZone("Asia/Taipei");
  switch (period) {
    case "today":
      return { date: now.toISODate() };
    case "week":
      return { date: { $gte: now.startOf("week").toISODate() } };
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "all":
    default:
      return {};
  }
}

async function fetchMessages(client, { guildId, period }) {
  if (!client.messageStatsCollection) {
    return { rows: [], total: 0, disabled: "🔧 訊息統計尚未啟動" };
  }

  const data = await client.messageStatsCollection
    .aggregate([
      { $match: { guildId, ...getDateFilter(period) } },
      {
        $group: {
          _id: "$userId",
          totalMessages: { $sum: "$messageCount" },
        },
      },
      { $sort: { totalMessages: -1 } },
      { $limit: 10 },
    ])
    .toArray();

  const rows = data.map((u) => ({
    id: u._id,
    mention: `<@${u._id}>`,
    detail: `**${u.totalMessages.toLocaleString()}** 則訊息`,
  }));

  return {
    rows,
    total: rows.length,
    emptyHint: "📊 目前還沒有訊息統計資料",
  };
}

module.exports = fetchMessages;
