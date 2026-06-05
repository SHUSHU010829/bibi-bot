const { DateTime } = require("luxon");

function startOfTodayTaipei() {
  return DateTime.now().setZone("Asia/Taipei").startOf("day").toJSDate();
}

async function getTodayBoughtQty(client, { userId, guildId, itemId }) {
  if (!client.shopTransactionsCollection) return 0;
  const agg = await client.shopTransactionsCollection
    .aggregate([
      { $match: { userId, guildId, itemId, createdAt: { $gte: startOfTodayTaipei() } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ])
    .toArray()
    .catch(() => []);
  return agg[0]?.total || 0;
}

// 批次查詢一組 itemId 今日已購數量，回傳 Map<itemId, number>
async function getTodayBoughtMap(client, { userId, guildId, itemIds }) {
  const map = new Map();
  if (!client.shopTransactionsCollection || !itemIds?.length) return map;
  const rows = await client.shopTransactionsCollection
    .aggregate([
      {
        $match: {
          userId,
          guildId,
          itemId: { $in: itemIds },
          createdAt: { $gte: startOfTodayTaipei() },
        },
      },
      { $group: { _id: "$itemId", total: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ])
    .toArray()
    .catch(() => []);
  for (const r of rows) map.set(r._id, r.total || 0);
  return map;
}

module.exports = { getTodayBoughtQty, getTodayBoughtMap };
