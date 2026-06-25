// 刮刮樂（對中獎號碼版）狀態圖：satori（HTML/CSS flex）。
//   上方「幸運號碼」一排（明示）；下方 3×3「你的號碼」，每格＝號碼 + 該格倍率。
//   未刮＝銀色塗層 + ?；刮開＝顯示號碼/倍率；對中幸運號碼的格金框+綠底高亮。
//   互動仍由按鈕進行，這張圖只是視覺。

const { renderCard } = require("./cardRenderer");

const P = {
  bg: "#0E1A1C",
  panel: "#14292C",
  ink: "#F4ECD8",
  muted: "#86B0B2",
  accent: "#FFD84D",
  cover: "#5A6A6C",
  coverEdge: "#7C8C8E",
  open: "#1C3A3E",
};
const TINT = { win: "#5BD68A", lose: "#D89AA4", play: "#FFD84D" };

const CELL_W = 108;
const CELL_H = 92;
const CELL_GAP = 12;
const PAD = 28;
const INNER_PAD_X = 26;
const BORDER = 3;

// 前綴符號（× / ＋ / －）與數字拆兩個 span，避免 SpaceMono 下黏在一起像被劃掉。
function prefixNum(prefix, value, color, size = 22) {
  return `<div style="display:flex;align-items:baseline;font-family:'SpaceMono';font-weight:700;color:${color};">
      <div style="display:flex;font-size:${size - 4}px;margin-right:4px;">${prefix}</div>
      <div style="display:flex;font-size:${size}px;letter-spacing:1px;">${value}</div>
    </div>`;
}

function isMatch(state, idx) {
  return state.luckyNumbers.includes(state.cells[idx].number);
}

function luckyRow(state) {
  const boxes = state.luckyNumbers
    .map(
      (n) =>
        `<div style="display:flex;width:62px;height:48px;align-items:center;justify-content:center;background:${P.accent};border:3px solid ${P.ink};box-sizing:border-box;font-family:'SpaceMono';font-weight:700;font-size:26px;color:${P.bg};">${n}</div>`
    )
    .join("");
  return `<div style="display:flex;flex-direction:row;align-items:center;justify-content:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${P.accent};letter-spacing:3px;margin-right:14px;padding-right:3px;">幸運號碼</div>
      <div style="display:flex;flex-direction:row;gap:10px;">${boxes}</div>
    </div>`;
}

function cellMarkup(state, idx) {
  const revealed = state.revealed.includes(idx);
  if (!revealed) {
    return `<div style="display:flex;width:${CELL_W}px;height:${CELL_H}px;align-items:center;justify-content:center;background:${P.cover};border:3px solid ${P.coverEdge};box-sizing:border-box;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:#48585A;">?</div>
      </div>`;
  }
  const cell = state.cells[idx];
  const matched = isMatch(state, idx);
  const settledWin = state.status !== "playing" && matched;
  const bg = matched ? "#2E7D4F" : P.open;
  const border = matched ? "4px solid #FFD84D" : "3px solid rgba(0,0,0,0.3)";
  const numColor = matched ? "#FFF4E0" : P.ink;
  const prizeColor = matched ? P.accent : P.muted;
  return `<div style="display:flex;flex-direction:column;width:${CELL_W}px;height:${CELL_H}px;align-items:center;justify-content:center;background:${bg};border:${border};box-sizing:border-box;">
      <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:32px;color:${numColor};letter-spacing:1px;">${cell.number}</div>
      <div style="display:flex;margin-top:4px;">${prefixNum("×", cell.prize, prizeColor, 15)}</div>
    </div>`;
}

function gridMarkup(state) {
  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const cells = [];
    for (let c = 0; c < 3; c += 1) cells.push(cellMarkup(state, r * 3 + c));
    rows.push(
      `<div style="display:flex;flex-direction:row;gap:${CELL_GAP}px;">${cells.join("")}</div>`
    );
  }
  return `<div style="display:flex;flex-direction:column;gap:${CELL_GAP}px;">${rows.join("")}</div>`;
}

function buildMarkup(state, opts) {
  const { username, balance, cardW, cardH } = opts;
  const playing = state.status === "playing";
  const win = state.result === "win";
  const tint = playing ? TINT.play : win ? TINT.win : TINT.lose;

  let headline;
  if (playing) {
    headline = `刮開 ${state.revealed.length} / 9`;
  } else if (win) {
    const num = state.cells[state.winIndex]?.number;
    headline = `對中 ${num} ・ 中獎 ×${state.multiplier}`;
  } else {
    headline = `銘謝惠顧`;
  }

  let footRight;
  if (playing) {
    footRight = `
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">對中幸運號碼</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;margin-top:3px;padding-right:2px;">即中獎</div>
      </div>`;
  } else {
    const net = (state.payout || 0) - state.bet;
    const sign = net > 0 ? "＋" : net < 0 ? "－" : "±";
    footRight = `
      <div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:22px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">淨輸贏</div>
        <div style="display:flex;margin-top:2px;">${prefixNum(sign, Math.abs(net).toLocaleString(), tint, 22)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">餘額</div>
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;letter-spacing:1px;">${typeof balance === "number" ? balance.toLocaleString() : "—"}</div>
      </div>`;
  }

  return `
    <div style="display:flex;width:${cardW}px;height:${cardH}px;background:${P.bg};padding:${PAD}px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${P.panel};border:3px solid ${P.ink};padding:22px ${INNER_PAD_X}px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:54px;height:54px;background:${P.accent};align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:700;font-size:20px;color:${P.bg};">SC</div>
            <div style="display:flex;margin-left:16px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${P.ink};letter-spacing:6px;padding-right:6px;">刮 刮 樂</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 14px;background:${P.ink};font-family:'NotoSansTC';font-weight:500;font-size:15px;color:${P.bg};letter-spacing:3px;padding-right:18px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:12px;border-top:2px dashed ${P.muted};"></div>

        <div style="display:flex;flex-direction:column;align-items:center;margin-top:14px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${tint};letter-spacing:3px;padding-right:3px;">${headline}</div>
          <div style="display:flex;margin-top:14px;">${luckyRow(state)}</div>
          <div style="display:flex;margin-top:14px;">${gridMarkup(state)}</div>
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:16px;border-top:2px dashed ${P.muted};">
          <div style="display:flex;flex-direction:column;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:20px;color:${P.ink};letter-spacing:2px;padding-right:2px;">${username || "玩家"}</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;margin-top:3px;padding-right:2px;">下注 ${state.bet.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">${footRight}</div>
        </div>

      </div>
    </div>
  `;
}

async function generateScratchCard(state, opts = {}) {
  const gridW = CELL_W * 3 + CELL_GAP * 2;
  const contentW = Math.max(gridW, 460);
  const cardW = contentW + (PAD + BORDER + INNER_PAD_X) * 2;
  const gridH = CELL_H * 3 + CELL_GAP * 2;
  const cardH = gridH + 380; // 頁首 + 標題 + 幸運號碼列 + 頁尾固定高
  const markup = buildMarkup(state, { ...opts, cardW, cardH });
  return renderCard({ markup, width: cardW, height: cardH });
}

module.exports = generateScratchCard;
