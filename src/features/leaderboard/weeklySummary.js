// 週報複合榜：把本週挖礦數量、本週礦石市值、稱號收藏各取 Top 3，
// 組成單一截圖友善的 Embed。供 /排行榜「週報」類別與 Dashboard API 共用。

const miningLeaderboard = require("./miningLeaderboard");
const titleLeaderboard = require("./titleLeaderboard");
const rankService = require("../mining/rankService");
const { COIN_EMOJI } = require("../../constants/coin");

// 回傳結構化資料（供 API）：
// { mining: [{userId,total,count}], value: [{userId,value}], titles: [{userId,titleCount}], resetEpoch }
async function data(client, guildId, topN = 3) {
  const [mining, value, titles] = await Promise.all([
    miningLeaderboard.byCount(client, guildId, "week", topN),
    miningLeaderboard.byValue(client, guildId, "week", topN),
    titleLeaderboard.topByTitleCount(client, guildId, topN),
  ]);
  const { end } = rankService.currentWeekWindow();
  return {
    mining,
    value,
    titles,
    resetEpoch: Math.floor(end.getTime() / 1000),
  };
}

const MEDALS = ["🥇", "🥈", "🥉"];

function asRows(list, fmt) {
  return list.map((item, i) => ({
    mention: `<@${item.userId}>`,
    detail: fmt(item),
    medal: MEDALS[i] || `**${i + 1}.**`,
  }));
}

// 回傳給 render 用的 sections 結構。
async function sections(client, guildId, topN = 3) {
  const d = await data(client, guildId, topN);
  return {
    sections: [
      {
        title: "⛏️ 本週挖礦數量",
        rows: asRows(
          d.mining,
          (r) => `**${r.total.toLocaleString()}** 顆（${r.count} 次）`
        ),
        emptyHint: "本週還沒有人挖礦",
      },
      {
        title: "💎 本週礦石市值",
        rows: asRows(
          d.value,
          (r) => `**${r.value.toLocaleString()}** ${COIN_EMOJI}`
        ),
        emptyHint: "本週還沒有人賣得出市值",
      },
      {
        title: "🏆 稱號收藏",
        rows: asRows(d.titles, (r) => `**${r.titleCount}** 個稱號`),
        emptyHint: "還沒有人解鎖稱號",
      },
    ],
    footer: `本週結算 <t:${d.resetEpoch}:R>`,
  };
}

module.exports = { data, sections };
