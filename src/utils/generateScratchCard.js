// 刮刮樂（Scratch）狀態圖：用 satori（HTML/CSS flex）畫一張 3×3 刮刮卡。
//   未刮的格＝銀色塗層 + ?；刮開＝顯示符號；結算中獎的三格金框高亮。
//   互動仍由按鈕進行，這張圖只是視覺。
// 與其他賭場卡同套渲染管線（renderCard → worker → resvg → PNG）。

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
const TINT = {
  win: "#5BD68A",
  lose: "#D89AA4",
  play: "#FFD84D",
};

const CELL = 100;
const CELL_GAP = 12;
const PAD = 28;
const INNER_PAD_X = 26;
const BORDER = 3;

// 前綴符號（＋ / －）與數字拆兩個 span，避免 SpaceMono 下黏在一起像被劃掉。
function prefixNum(prefix, value, color, size = 22) {
  return `<div style="display:flex;align-items:baseline;font-family:'SpaceMono';font-weight:700;color:${color};">
      <div style="display:flex;font-size:${size - 4}px;margin-right:5px;">${prefix}</div>
      <div style="display:flex;font-size:${size}px;letter-spacing:1px;">${value}</div>
    </div>`;
}

function cellMarkup(state, idx) {
  const revealed = state.revealed.includes(idx);
  const sym = state.grid[idx];
  const isWin =
    state.status !== "playing" && state.winSymbol && sym === state.winSymbol;

  if (!revealed) {
    return `<div style="display:flex;width:${CELL}px;height:${CELL}px;align-items:center;justify-content:center;background:${P.cover};border:3px solid ${P.coverEdge};box-sizing:border-box;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:40px;color:#48585A;">?</div>
      </div>`;
  }
  const bg = isWin ? "#2E7D4F" : P.open;
  const border = isWin ? "4px solid #FFD84D" : "3px solid rgba(0,0,0,0.3)";
  return `<div style="display:flex;width:${CELL}px;height:${CELL}px;align-items:center;justify-content:center;background:${bg};border:${border};box-sizing:border-box;">
      <div style="display:flex;font-size:52px;">${sym}</div>
    </div>`;
}

function gridMarkup(state) {
  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const cells = [];
    for (let c = 0; c < 3; c += 1) {
      cells.push(cellMarkup(state, r * 3 + c));
    }
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
    headline = `中獎 ${state.winSymbol} ×${state.multiplier}`;
  } else {
    headline = `銘謝惠顧`;
  }

  let footRight;
  if (playing) {
    footRight = `
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">湊滿三個相同</div>
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
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;">${typeof balance === "number" ? balance.toLocaleString() : "—"}</div>
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

        <div style="display:flex;flex-direction:column;align-items:center;margin-top:16px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:28px;color:${tint};letter-spacing:4px;padding-right:4px;">${headline}</div>
          <div style="display:flex;margin-top:16px;">${gridMarkup(state)}</div>
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
  const gridW = CELL * 3 + CELL_GAP * 2;
  const contentW = Math.max(gridW, 460);
  const cardW = contentW + (PAD + BORDER + INNER_PAD_X) * 2;
  const gridH = CELL * 3 + CELL_GAP * 2;
  const cardH = gridH + 340; // 頁首 + 標題 + 頁尾固定高（含底部留白）
  const markup = buildMarkup(state, { ...opts, cardW, cardH });
  return renderCard({ markup, width: cardW, height: cardH });
}

module.exports = generateScratchCard;
