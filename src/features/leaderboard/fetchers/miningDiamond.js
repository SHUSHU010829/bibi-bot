const { mining } = require("../../../config");
const miningLeaderboard = require("../miningLeaderboard");

// 鑽石獵人榜：依累計挖到的鑽石數排名（全時）。
async function fetchMiningDiamond(client, { guildId, viewerId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { rows: [], total: 0, disabled: "🔧 挖礦系統尚未啟動！" };
  }

  const ranking = await miningLeaderboard.byDiamond(client, guildId, 10);
  const diamondEmoji = mining?.ores?.diamond?.emoji || "💎";
  const rows = ranking.map((r) => ({
    id: r.userId,
    mention: `<@${r.userId}>`,
    detail: `${diamondEmoji} **${r.diamonds.toLocaleString()}** 顆`,
  }));

  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const all = await miningLeaderboard
      .byDiamond(client, guildId, 9999)
      .catch(() => []);
    const idx = all.findIndex((r) => r.userId === viewerId);
    if (idx >= 0) {
      myRank = idx + 1;
      myDetail = `${diamondEmoji} **${all[idx].diamonds.toLocaleString()}** 顆`;
    }
  }

  return {
    rows,
    total: rows.length,
    myRank,
    myDetail,
    footer: "依累計挖到的鑽石數統計（全時）",
    emptyHint: "📊 還沒有人挖到鑽石，傳說等你來寫 💎！",
  };
}

module.exports = fetchMiningDiamond;
