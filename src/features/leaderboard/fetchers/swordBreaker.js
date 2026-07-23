const { dungeon } = require("../../../config");
const swordBreakService = require("../../dungeon/swordBreakService");

// 斷劍王榜：雙週視窗（每月 1 號 / 16 號結算）或全時累積，統計把「傳說之劍」砍斷的次數。
async function fetchSwordBreaker(client, { guildId, viewerId, period }) {
  if (!dungeon?.enabled || !client.swordBreaksCollection) {
    return { rows: [], total: 0, disabled: "🔧 地下城系統尚未啟動！" };
  }

  const lifetime = period === "all";
  const win = lifetime ? null : swordBreakService.currentWindow();

  const ranking = lifetime
    ? await swordBreakService.rankLifetime(client, guildId, 10)
    : await swordBreakService.rankByWindow(client, guildId, win, 10);

  const rows = ranking.map((r) => ({
    id: r.userId,
    mention: `<@${r.userId}>`,
    detail: `**${r.breaks.toLocaleString()}** 次`,
  }));

  // 自己若不在 top 10，也算一下名次
  let myRank = null;
  let myDetail = null;
  if (viewerId && !rows.some((r) => r.id === viewerId)) {
    const all = lifetime
      ? await swordBreakService.rankLifetime(client, guildId, 9999)
      : await swordBreakService.rankByWindow(client, guildId, win, 9999);
    const idx = all.findIndex((r) => r.userId === viewerId);
    if (idx >= 0) {
      myRank = idx + 1;
      myDetail = `**${all[idx].breaks.toLocaleString()}** 次`;
    }
  }

  const footer = lifetime
    ? "生涯累計把 🔥 傳說之劍 砍斷的次數（不重置）"
    : `本期 ${win.label} 結算 <t:${Math.floor(win.end.getTime() / 1000)}:R>，斷最多的人封為 ☠️ 斷劍王，領受「亡靈制」加成`;

  return {
    rows,
    total: rows.length,
    myRank,
    myDetail,
    footer,
    emptyHint: lifetime
      ? "📊 還沒有人把傳說之劍砍斷過，先去 /合成 打一把 🔥 傳說之劍再說。"
      : "📊 本期還沒有人斷劍，去 /地下城 用 🔥 傳說之劍猛砍，搶下第一個 ☠️ 斷劍王！",
  };
}

module.exports = fetchSwordBreaker;
