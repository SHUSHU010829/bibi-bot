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

async function fetchChannels(client, { guildId, period }) {
  if (!client.channelActivityCollection) {
    return { rows: [], total: 0, disabled: "🔧 頻道活躍度統計尚未啟動" };
  }

  const data = await client.channelActivityCollection
    .aggregate([
      { $match: { guildId, ...getDateFilter(period) } },
      {
        $group: {
          _id: "$channelId",
          totalMessages: { $sum: "$messageCount" },
          allActiveUsers: { $push: "$activeUsers" },
        },
      },
      { $sort: { totalMessages: -1 } },
      { $limit: 10 },
    ])
    .toArray();

  const rows = data.map((c) => {
    const uniqueUsers = new Set(c.allActiveUsers.flat()).size;
    return {
      id: c._id,
      mention: `<#${c._id}>`,
      detail: `**${c.totalMessages.toLocaleString()}** 則訊息 ・ **${uniqueUsers}** 位活躍用戶`,
    };
  });

  return {
    rows,
    total: rows.length,
    emptyHint: "📊 目前還沒有頻道統計資料",
  };
}

module.exports = fetchChannels;
