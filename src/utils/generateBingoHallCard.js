// 賓果大廳「兌獎圖」：5×5 卡片，標記中球、高亮完成的連線，附中獎獎項與金額。
// 走共用 satori renderCard（與其他賭場圖卡同風格，無 node-canvas 依賴）。

const { renderCard } = require("./cardRenderer");
const { buildMarks } = require("../features/casino/bingo/engine");

const PALETTE = {
  card: "#F4ECD8",
  ink: "#2A2420",
  muted: "#A89270",
  white: "#FBF7EC",
  red: "#C9302C",
  teal: "#3D6F6A",
  gold: "#D4A437",
  hot: "#E8B84B",
  empty: "#E5DBC2",
};

const HEADERS = ["B", "I", "N", "G", "O"];

function prizeText(prize, lines) {
  if (prize === "jackpot") return lines >= 12 ? "全餐 BINGO!" : "頭彩";
  return "連線中獎";
}

// 標出屬於「已完成連線」的格子，畫圖時高亮。
function hotCells(marks) {
  const hot = Array.from({ length: 5 }, () => Array(5).fill(false));
  for (let r = 0; r < 5; r++) {
    if (marks[r].every(Boolean)) for (let c = 0; c < 5; c++) hot[r][c] = true;
  }
  for (let c = 0; c < 5; c++) {
    let all = true;
    for (let r = 0; r < 5; r++) if (!marks[r][c]) all = false;
    if (all) for (let r = 0; r < 5; r++) hot[r][c] = true;
  }
  let d1 = true;
  let d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marks[i][i]) d1 = false;
    if (!marks[i][4 - i]) d2 = false;
  }
  if (d1) for (let i = 0; i < 5; i++) hot[i][i] = true;
  if (d2) for (let i = 0; i < 5; i++) hot[i][4 - i] = true;
  return hot;
}

function cellMarkup(card, marks, hot, r, c) {
  const v = card[r][c];
  const isFree = v === 0;
  const marked = marks[r][c];
  const isHot = hot[r][c];

  let bg = PALETTE.white;
  let fg = PALETTE.ink;
  let border = `3px solid ${PALETTE.muted}`;
  let text = String(v).padStart(2, "0");

  if (isFree) {
    bg = PALETTE.teal;
    fg = PALETTE.white;
    text = "★";
    border = `3px solid ${PALETTE.ink}`;
  } else if (isHot) {
    bg = PALETTE.hot;
    fg = PALETTE.ink;
    border = `4px solid ${PALETTE.red}`;
  } else if (marked) {
    bg = PALETTE.gold;
    fg = PALETTE.ink;
    border = `3px solid ${PALETTE.ink}`;
  } else {
    bg = PALETTE.empty;
    fg = PALETTE.muted;
  }

  return `<div style="display:flex;width:104px;height:104px;background:${bg};border:${border};box-sizing:border-box;align-items:center;justify-content:center;margin:4px;font-family:'NotoSansTC';font-weight:900;font-size:${isFree ? 52 : 40}px;color:${fg};">${text}</div>`;
}

function buildMarkup({ card, drawnBalls, lines, prize, payout, roundNumber, username }) {
  const drawnSet = new Set(drawnBalls || []);
  const marks = buildMarks(card, drawnSet);
  const hot = hotCells(marks);

  const headerRow = HEADERS.map(
    (h) =>
      `<div style="display:flex;width:104px;height:48px;align-items:center;justify-content:center;margin:4px;font-family:'SpaceMono';font-weight:700;font-size:34px;color:${PALETTE.teal};letter-spacing:4px;">${h}</div>`
  ).join("");

  const gridRows = [];
  for (let r = 0; r < 5; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) row.push(cellMarkup(card, marks, hot, r, c));
    gridRows.push(`<div style="display:flex;">${row.join("")}</div>`);
  }

  const isJackpot = prize === "jackpot";
  const bannerBg = isJackpot ? PALETTE.gold : PALETTE.teal;

  return `
    <div style="display:flex;width:680px;height:900px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 32px;box-sizing:border-box;align-items:center;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.ink};letter-spacing:4px;">賓果大廳</div>
          <div style="display:flex;padding:6px 16px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${PALETTE.card};letter-spacing:2px;">第 ${roundNumber} 場</div>
        </div>

        <div style="display:flex;margin-top:6px;width:100%;font-family:'SpaceMono';font-size:14px;color:${PALETTE.muted};letter-spacing:2px;">@${username || "player"}</div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;margin-top:20px;">${headerRow}</div>
        <div style="display:flex;flex-direction:column;align-items:center;">${gridRows.join("")}</div>

        <div style="display:flex;margin-top:24px;padding:12px 28px;background:${bannerBg};border:3px solid ${PALETTE.ink};align-items:center;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${isJackpot ? PALETTE.ink : PALETTE.white};letter-spacing:2px;">${prizeText(prize, lines)} ・ ${lines} 線</div>
        </div>
        <div style="display:flex;margin-top:14px;align-items:flex-end;">
          <div style="display:flex;font-family:'SpaceMono';font-size:16px;letter-spacing:4px;color:${PALETTE.muted};padding-right:6px;">WIN</div>
          <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:44px;color:${PALETTE.red};line-height:1;">+${(payout || 0).toLocaleString()}</div>
        </div>

        <div style="display:flex;width:100%;justify-content:flex-end;margin-top:auto;">
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${PALETTE.muted};">逼逼賭場 · BINGO HALL</div>
        </div>

      </div>
    </div>
  `;
}

async function generateBingoHallCard(opts) {
  const markup = buildMarkup(opts);
  return renderCard({ markup, width: 680, height: 900 });
}

module.exports = generateBingoHallCard;
module.exports.buildMarkup = buildMarkup;
