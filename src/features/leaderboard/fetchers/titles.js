const titleLeaderboard = require("../titleLeaderboard");

// 稱號收藏榜：依已解鎖稱號數排名（全時）。
async function fetchTitles(client, { guildId, viewerId }) {
  if (!client.userLevelsCollection) {
    return { rows: [], total: 0, disabled: "🔧 稱號系統尚未啟動！" };
  }

  const ranking = await titleLeaderboard.topByTitleCount(client, guildId, 10);
  const rows = ranking.map((r) => ({
    id: r.userId,
    mention: `<@${r.userId}>`,
    detail: `**${r.titleCount}** 個稱號`,
  }));

  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const all = await titleLeaderboard
      .topByTitleCount(client, guildId, 9999)
      .catch(() => []);
    const idx = all.findIndex((r) => r.userId === viewerId);
    if (idx >= 0) {
      myRank = idx + 1;
      myDetail = `**${all[idx].titleCount}** 個稱號`;
    }
  }

  return {
    rows,
    total: rows.length,
    myRank,
    myDetail,
    emptyHint: "📊 還沒有人解鎖稱號",
  };
}

module.exports = fetchTitles;
