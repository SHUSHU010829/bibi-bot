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

async function fetchVoice(client, { guildId, period }) {
  if (!client.voiceStatsCollection) {
    return { rows: [], total: 0, disabled: "🔧 語音統計尚未啟動" };
  }

  const data = await client.voiceStatsCollection
    .aggregate([
      { $match: { guildId, ...getDateFilter(period) } },
      {
        $group: {
          _id: "$userId",
          totalMinutes: { $sum: "$durationMinutes" },
        },
      },
      { $sort: { totalMinutes: -1 } },
      { $limit: 10 },
    ])
    .toArray();

  const rows = data.map((u) => {
    const hours = Math.floor(u.totalMinutes / 60);
    const minutes = u.totalMinutes % 60;
    return {
      id: u._id,
      mention: `<@${u._id}>`,
      detail: `**${hours}** 小時 **${minutes}** 分鐘`,
    };
  });

  return {
    rows,
    total: rows.length,
    emptyHint: "📊 目前還沒有語音統計資料",
  };
}

module.exports = fetchVoice;
