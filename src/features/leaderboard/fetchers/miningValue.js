const { mining } = require("../../../config");
const miningLeaderboard = require("../miningLeaderboard");
const { COIN_EMOJI } = require("../../../constants/coin");

// 挖礦市值榜：依 qty × 礦石單價加總，支援 week / month / all。
async function fetchMiningValue(client, { guildId, viewerId, period }) {
  if (!mining?.enabled || !client.mineLogsCollection) {
    return { rows: [], total: 0, disabled: "🔧 挖礦系統尚未啟動！" };
  }

  const ranking = await miningLeaderboard.byValue(client, guildId, period, 10);
  const rows = ranking.map((r) => ({
    id: r.userId,
    mention: `<@${r.userId}>`,
    detail: `**${r.value.toLocaleString()}** ${COIN_EMOJI}（${r.count} 次）`,
  }));

  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const all = await miningLeaderboard
      .byValue(client, guildId, period, 9999)
      .catch(() => []);
    const idx = all.findIndex((r) => r.userId === viewerId);
    if (idx >= 0) {
      myRank = idx + 1;
      myDetail = `**${all[idx].value.toLocaleString()}** ${COIN_EMOJI}（${all[idx].count} 次）`;
    }
  }

  return {
    rows,
    total: rows.length,
    myRank,
    myDetail,
    emptyHint: "📊 這段期間還沒有挖礦市值資料，快去 `/挖礦`！",
  };
}

module.exports = fetchMiningValue;
