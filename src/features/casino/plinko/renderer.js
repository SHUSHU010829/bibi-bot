// Plinko Discord 訊息 payload 渲染。一翻定生死，只有結果畫面。

const { MONEY_EMOJI } = require("../../../constants/coin");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");

const RISK_LABEL = { low: "低風險", medium: "中風險", high: "高風險" };

function fmtMul(x) {
  return `${x}x`;
}

// 把落點倍率表畫成一行，標出命中的格子。
function renderBuckets(row, bucket) {
  return row
    .map((m, i) => (i === bucket ? `【${fmtMul(m)}】` : `${fmtMul(m)}`))
    .join(" ");
}

// 用箭頭把落球路徑畫出來（左右擺動）。
function renderPath(path) {
  return path.map((d) => (d === "L" ? "↙" : "↘")).join("");
}

async function renderMessage(result, { username, balance, userId, avatarURL } = {}) {
  const { bet, risk, rows, row, bucket, multiplier, payout, net, path } = result;
  const win = payout > bet;
  const breakeven = payout === bet;
  const outcome = win ? "win" : breakeven ? "neutral" : "lose";

  const headline = win
    ? `🎉 **命中 ×${multiplier}！** 拿走 ${payout.toLocaleString()} credits`
    : breakeven
      ? `➖ **打平！** 退回 ${payout.toLocaleString()} credits`
      : `💧 **命中 ×${multiplier}** ・ －${(bet - payout).toLocaleString()} credits`;

  const lines = [
    `風險：**${RISK_LABEL[risk] || risk}**　・　排數：**${rows}**　・　落點：第 ${bucket + 1} 格`,
    "```",
    `路徑 ${renderPath(path)}`,
    renderBuckets(row, bucket),
    "```",
  ];

  const components = userId
    ? [buildReplayRow("plinko", userId, { name: username })]
    : [];

  const embed = buildCasinoEmbed({
    game: "🔵 Plinko",
    user: { id: userId, displayName: username, avatarURL },
    outcome,
    headline,
    lines,
    bet,
    net,
    balance: typeof balance === "number" ? balance : undefined,
  });

  return { content: "", embeds: [embed], components, files: [] };
}

module.exports = { renderMessage, renderBuckets, RISK_LABEL };
