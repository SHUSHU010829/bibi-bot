// 稱號收藏排行：依 UserLevels.gameTitles 陣列長度排名（全時）。
// 同時供 /排行榜 fetcher 與 Dashboard HTTP API 取用。

// 回傳 [{ userId, titleCount }]
async function topByTitleCount(client, guildId, limit = 10) {
  if (!client?.userLevelsCollection) return [];
  const rows = await client.userLevelsCollection
    .aggregate([
      { $match: { guildId, gameTitles: { $exists: true, $ne: [] } } },
      {
        $project: {
          userId: 1,
          titleCount: { $size: { $ifNull: ["$gameTitles", []] } },
        },
      },
      { $match: { titleCount: { $gt: 0 } } },
      { $sort: { titleCount: -1 } },
      { $limit: limit },
    ])
    .toArray()
    .catch(() => []);
  return rows.map((r) => ({ userId: r.userId, titleCount: r.titleCount }));
}

module.exports = { topByTitleCount };
