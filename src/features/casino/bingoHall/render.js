// 賓果大廳訊息組裝（純組裝）。改為頻道按鈕驅動：開場貼購買訊息(按鈕選張數)，
// 開獎貼中獎資訊，免指令。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
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

// 開場購買訊息（公開、含買卡按鈕）。
function buildBuyMessage(round, { ticketPrice, buyOptions = [1, 5, 10, 20] } = {}) {
  const content =
    `# 🎱 賓果大廳 第 ${round.roundNumber} 場 開賣中！\n` +
    `累積頭彩：**${(round.jackpotPoolIn || 0).toLocaleString()}** ${MONEY_EMOJI}　・　一張 **${ticketPrice.toLocaleString()}** ${MONEY_EMOJI}\n` +
    `⏰ 開球 ${countdownTag(round.scheduledAt)}（時間到自動開球，免指令）\n\n` +
    `-# 點下方按鈕直接買卡。開出 30 球，完成的連線越多分越多，連線最多者獨得累積頭彩！中獎會私訊你兌獎圖。`;

  const row = new ActionRowBuilder().addComponents(
    buyOptions.map((n) =>
      new ButtonBuilder()
        .setCustomId(`bh_buy_${round.roundId}_${n}`)
        .setLabel(`買 ${n} 張`)
        .setEmoji("🎟️")
        .setStyle(ButtonStyle.Success)
    )
  );
  return { content, components: [row] };
}

// 開球後把舊購買訊息收掉（移除按鈕）。
function buildClosedMessage(round) {
  return {
    content:
      `# 🎱 賓果大廳 第 ${round.roundNumber} 場 已截止開球\n` +
      `-# 開球結果請見下方，新一場已開賣 👇`,
    components: [],
  };
}

// 玩家買卡後的 ephemeral 回覆。
function buildBuyReply({ round, cards, cost, balance, totalCardsThisRound }) {
  const preview = cards.length === 1 ? `\n${renderCardText(cards[0].card)}` : "";
  return (
    `🎟️ 已買 **${cards.length}** 張卡（第 ${round.roundNumber} 場）\n` +
    `花費 **${cost.toLocaleString()}** ${MONEY_EMOJI}　餘額 **${balance.toLocaleString()}**\n` +
    `你本場共 **${totalCardsThisRound}** 張　・　開球 ${countdownTag(round.scheduledAt)}${preview}`
  );
}

function buildAnnounce({ round, settle, drawnBalls }) {
  const drawnStr = drawnBalls
    .slice()
    .sort((a, b) => a - b)
    .map((n) => String(n).padStart(2, "0"))
    .join(" ");

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
    `\n-# 中獎者已收到私訊兌獎圖。新一場已開賣，往上買卡 👆`;

  return { content: body };
}

module.exports = {
  renderCardText,
  buildBuyMessage,
  buildClosedMessage,
  buildBuyReply,
  buildAnnounce,
};
