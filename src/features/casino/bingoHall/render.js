// 賓果大廳訊息組裝（純文字，公開導向）。

const { MONEY_EMOJI } = require("../../../constants/coin");

const HEADERS = ["B", "I", "N", "G", "O"];

// 把 5×5 卡片畫成文字格。drawnSet 有給就標記中球（【】），FREE 中央顯示 ⭐。
function renderCardText(card, drawnSet = null) {
  const lines = [`\`${HEADERS.join("  ")}\``];
  for (let r = 0; r < 5; r++) {
    const cells = [];
    for (let c = 0; c < 5; c++) {
      const v = card[r][c];
      if (v === 0) {
        cells.push("⭐");
        continue;
      }
      const s = String(v).padStart(2, "0");
      if (drawnSet && drawnSet.has(v)) cells.push(`【${s}】`);
      else cells.push(` ${s} `);
    }
    lines.push(cells.join(""));
  }
  return lines.join("\n");
}

function countdownTag(scheduledAt) {
  return `<t:${Math.floor(new Date(scheduledAt).getTime() / 1000)}:R>`;
}

function buildBuyReply({ round, cards, cost, balance, totalCardsThisRound }) {
  const preview = cards.length === 1 ? `\n${renderCardText(cards[0].card)}` : "";
  const jackpot = round.jackpotPoolIn || 0;
  return (
    `🎱 **賓果大廳** 第 ${round.roundNumber} 場 ・ 買了 **${cards.length}** 張卡\n` +
    `花費 **${cost.toLocaleString()}** ${MONEY_EMOJI}　餘額 **${balance.toLocaleString()}**\n` +
    `你本場共 **${totalCardsThisRound}** 張　・　目前累積大獎 **${jackpot.toLocaleString()}** ${MONEY_EMOJI}\n` +
    `⏰ 開球 ${countdownTag(round.scheduledAt)}（時間到自動開獎，免等人開）${preview}`
  );
}

function buildInfoReply({ round, userCards, ticketPrice }) {
  if (!round) return "🎱 目前沒有進行中的賓果大廳場次，稍後再來～";
  const yourLine = userCards > 0 ? `你本場有 **${userCards}** 張卡` : "你本場還沒買卡";
  return (
    `# 🎱 賓果大廳 第 ${round.roundNumber} 場\n` +
    `累積大獎(全餐)：**${(round.jackpotPoolIn || 0).toLocaleString()}** ${MONEY_EMOJI}\n` +
    `本場銷售彩池：**${(round.pool || 0).toLocaleString()}** ${MONEY_EMOJI} ・ 共 ${round.totalCards || 0} 張卡\n` +
    `${yourLine}\n` +
    `⏰ 開球倒數：${countdownTag(round.scheduledAt)}\n\n` +
    `-# 一張 ${ticketPrice.toLocaleString()} ${MONEY_EMOJI}，用 \`/賓果大廳 買卡\` 進場。開出 30 球，連線越多分越多，全餐獨得累積大獎！`
  );
}

function buildAnnounce({ round, settle, drawnBalls }) {
  const drawnStr = drawnBalls
    .slice()
    .sort((a, b) => a - b)
    .map((n) => String(n).padStart(2, "0"))
    .join(" ");

  // 連線獎前幾名
  const lineWinners = settle.results
    .filter((r) => r.prize === "lines" && r.payout > 0)
    .sort((a, b) => b.payout - a.payout)
    .slice(0, 5)
    .map((r) => `・<@${r.userId}> ${r.lines} 線 +${r.payout.toLocaleString()}`)
    .join("\n");

  const jp = settle.results.filter((r) => r.prize === "jackpot");
  const fullHouse = jp.some((r) => r.lines >= 12);
  const jackpotLine =
    jp.length > 0
      ? `🏆 **${fullHouse ? "全餐 BINGO！" : "頭彩"}** ${jp.map((r) => `<@${r.userId}>`).join("・")}（${jp[0].lines} 線）獨得累積頭彩 **${jp[0].payout.toLocaleString()}** ${MONEY_EMOJI}`
      : `🎰 本場無人連線，累積頭彩滾至 **${settle.jackpotPoolOut.toLocaleString()}** ${MONEY_EMOJI}，下場見！`;

  const body =
    `# 🎱 賓果大廳 第 ${round.roundNumber} 場 開球結果\n` +
    `開出 30 球：\n\`${drawnStr}\`\n\n` +
    `${jackpotLine}\n` +
    (lineWinners ? `\n**連線獎**\n${lineWinners}\n` : "\n本場沒有人連線。\n") +
    `\n查看你的成績：\`/賓果大廳 資訊\``;

  return { content: body };
}

module.exports = { renderCardText, buildBuyReply, buildInfoReply, buildAnnounce };
