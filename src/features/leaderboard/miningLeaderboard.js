// 挖礦排行的多維度資料層：次數 / 市值 / 鑽石。
// 同時供 /排行榜 的 fetcher 與 Dashboard HTTP API 取用，確保兩邊口徑一致。

const { mining } = require("../../config");
const rankService = require("../mining/rankService");

function priceOf(ore) {
  return mining?.ores?.[ore]?.price || 0;
}

// 依挖礦「數量」排名（包裝 rankService，支援 today/week/month/all）。
// 回傳 [{ userId, total, count }]
async function byCount(client, guildId, period = "week", limit = 10) {
  const { start, end } = rankService.periodWindow(period);
  return rankService.rankByWindow(client, guildId, { start, end, limit });
}

// 依挖礦「市值」排名（qty × 礦石單價加總）。
// 回傳 [{ userId, value, count }]
async function byValue(client, guildId, period = "week", limit = 10) {
  if (!client?.mineLogsCollection) return [];
  const { start, end } = rankService.periodWindow(period);
  const rows = await client.mineLogsCollection
    .aggregate([
      { $match: { guild_id: guildId, ts: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: { user: "$user_id", ore: "$ore" },
          qty: { $sum: "$qty" },
          c: { $sum: 1 },
        },
      },
    ])
    .toArray()
    .catch(() => []);

  const agg = new Map();
  for (const r of rows) {
    const cur = agg.get(r._id.user) || { value: 0, count: 0 };
    cur.value += r.qty * priceOf(r._id.ore);
    cur.count += r.c;
    agg.set(r._id.user, cur);
  }
  return [...agg.entries()]
    .map(([userId, v]) => ({ userId, value: v.value, count: v.count }))
    .sort((a, b) => b.value - a.value || b.count - a.count)
    .slice(0, limit);
}

// 依累計挖到的鑽石數排名（全時，取自 miningProfile.lifetime_ore.diamond）。
// 回傳 [{ userId, diamonds }]
async function byDiamond(client, guildId, limit = 10) {
  if (!client?.miningProfilesCollection) return [];
  const rows = await client.miningProfilesCollection
    .find(
      { guildId, "lifetime_ore.diamond": { $gt: 0 } },
      { projection: { userId: 1, "lifetime_ore.diamond": 1 } }
    )
    .sort({ "lifetime_ore.diamond": -1 })
    .limit(limit)
    .toArray()
    .catch(() => []);
  return rows.map((r) => ({
    userId: r.userId,
    diamonds: r.lifetime_ore?.diamond || 0,
  }));
}

module.exports = { byCount, byValue, byDiamond, priceOf };
