const { mining } = require("../../../config");
const rankService = require("../../mining/rankService");

// 挖礦只支援週榜（系統設計就是每週重置 + 頒礦坑之王），period 一律當 week 看。
async function fetchMining(client, { guildId, viewerId }) {
  if (!mining?.enabled || !client.mineLogsCollection) {
    return { rows: [], total: 0, disabled: "🔧 挖礦系統尚未啟動！" };
  }

  const ranking = await rankService.currentWeekRanking(client, guildId, 10);
  const { end } = rankService.currentWeekWindow();
  const resetEpoch = Math.floor(end.getTime() / 1000);

  const rows = ranking.map((r) => ({
    id: r.userId,
    mention: `<@${r.userId}>`,
    detail: `**${r.total.toLocaleString()}** 顆（${r.count} 次）`,
  }));

  // 自己若不在 top 10，也算一下排名
  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const all = await rankService
      .currentWeekRanking(client, guildId, 9999)
      .catch(() => []);
    const idx = all.findIndex((r) => r.userId === viewerId);
    if (idx >= 0) {
      myRank = idx + 1;
      myDetail = `**${all[idx].total.toLocaleString()}** 顆（${all[idx].count} 次）`;
    }
  }

  return {
    rows,
    total: rows.length,
    myRank,
    myDetail,
    footer: `本週結算 <t:${resetEpoch}:R>（週一 00:01 頒發礦坑之王）`,
    emptyHint: "📊 本週還沒有人挖礦，快用 `/挖礦` 搶下第一個礦坑之王 👑！",
  };
}

module.exports = fetchMining;
