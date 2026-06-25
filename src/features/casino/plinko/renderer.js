// Plinko Discord 訊息 payload 渲染。一翻定生死，只有結果畫面。
// 主視覺是板面圖（generatePlinkoCard）；圖render失敗時退回文字版路徑/落點。

const { AttachmentBuilder } = require("discord.js");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
const generatePlinkoCard = require("../../../utils/generatePlinkoCard");

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

  let files = [];
  let imageName;
  let fallbackLines = [];
  try {
    const buf = await generatePlinkoCard(result, { username, balance });
    imageName = `plinko-${bucket}-${rows}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
  } catch (e) {
    console.log(`[WARN] plinko card render failed, falling back to text: ${e.message}`);
    fallbackLines = [
      `風險：**${RISK_LABEL[risk] || risk}**　・　排數：**${rows}**　・　落點：第 ${bucket + 1} 格`,
      "```",
      `路徑 ${renderPath(path)}`,
      renderBuckets(row, bucket),
      "```",
    ];
  }

  const components = userId
    ? [buildReplayRow("plinko", userId, { name: username })]
    : [];

  const embed = buildCasinoEmbed({
    game: "🔵 彈珠台",
    user: { id: userId, displayName: username, avatarURL },
    outcome,
    headline,
    lines: fallbackLines,
    bet,
    net,
    balance: typeof balance === "number" ? balance : undefined,
    imageName,
  });

  return { content: "", embeds: [embed], components, files };
}

module.exports = { renderMessage, renderBuckets, RISK_LABEL };
