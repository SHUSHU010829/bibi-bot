// 爬塔（Tower）狀態圖：用 satori（HTML/CSS flex）畫一座直式塔。
//   最高層在最上、底層在最下。每層一排格子 + 右側累積倍率。
//   ✅ 踩過的安全格   💣 揭曉的陷阱   💥 踩爆   數字=當層可選格   空=未到/未選
// 與 generatePlinkoCard 同套渲染管線（renderCard → worker → resvg → PNG）。

const { renderCard } = require("./cardRenderer");

const PAL_BASE = {
  bg: "#14110C",
  panel: "#241D14",
  ink: "#F4ECD8",
  muted: "#B6A07A",
  accent: "#FFD84D",
  line: "#4A3C28",
};
const TINT = {
  win: { headline: "#5BD68A", glow: "#1E3A26" },
  lose: { headline: "#FF6E7A", glow: "#3A181C" },
  play: { headline: "#FFD84D", glow: "#2A2114" },
};

const TILE = {
  picked: { bg: "#2E7D4F", fg: "#F4ECD8", glyph: "✅" },
  hit: { bg: "#C9302C", fg: "#FFF4E0", glyph: "💥" },
  trap: { bg: "#3A1E1C", fg: "#D89AA4", glyph: "💣" },
  safe: { bg: "#2A2418", fg: "#6E6450", glyph: "" },
  active: { bg: "#3D5A78", fg: "#FFF4E0", glyph: "" },
  locked: { bg: "#201A12", fg: "#4A4234", glyph: "" },
};

const LABEL_W = 64;
const TILE_W = 60;
const TILE_H = 46;
const TILE_GAP = 8;
const ROW_GAP = 10;
const MULT_W = 108;
const PAD = 28;
const INNER_PAD_X = 26;
const BORDER = 3;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 把前綴符號（× / ＋ / －）與數字拆成兩個 span，避免在 SpaceMono 下黏在一起
// 而看起來像被劃掉。純數字（無前綴）不需要走這個。
function prefixNum(prefix, value, color, size = 19) {
  return `<div style="display:flex;align-items:baseline;font-family:'SpaceMono';font-weight:700;color:${color};">
      <div style="display:flex;font-size:${size - 4}px;margin-right:5px;">${prefix}</div>
      <div style="display:flex;font-size:${size}px;letter-spacing:1px;">${value}</div>
    </div>`;
}

function reachMultiplier(state, floor) {
  return round2(Math.pow(state.floorMultiplier, floor + 1));
}

// 決定某一層、某一格要呈現哪種 tile。
function tileKind(state, floor, tile) {
  const playing = state.status === "playing";
  if (floor < state.currentFloor) {
    if (state.picks[floor] === tile) return "picked";
    return state.traps[floor].includes(tile) ? "trap" : "safe";
  }
  if (!playing && state.result === "lose" && floor === state.currentFloor) {
    if (tile === state.hitTile) return "hit";
    return state.traps[floor].includes(tile) ? "trap" : "safe";
  }
  if (playing && floor === state.currentFloor) return "active";
  return "locked";
}

function tileBox(state, floor, tile) {
  const kind = tileKind(state, floor, tile);
  const t = TILE[kind];
  // active 格顯示對應按鈕的編號，方便對照下方數字按鈕
  const content =
    kind === "active"
      ? `<div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:20px;color:${t.fg};">${tile + 1}</div>`
      : t.glyph
        ? `<div style="display:flex;font-size:22px;">${t.glyph}</div>`
        : "";
  return `<div style="display:flex;width:${TILE_W}px;height:${TILE_H}px;align-items:center;justify-content:center;background:${t.bg};border:2px solid rgba(0,0,0,0.3);box-sizing:border-box;">${content}</div>`;
}

function floorRow(state, floor) {
  const playing = state.status === "playing";
  const isCurrent = playing && floor === state.currentFloor;
  const isTop = floor === state.maxFloors - 1;

  const tiles = [];
  for (let t = 0; t < state.tilesPerFloor; t += 1) {
    tiles.push(tileBox(state, floor, t));
  }

  const labelColor = isCurrent ? PAL_BASE.accent : PAL_BASE.muted;
  // 獎盃放在固定寬的左欄，與文字保留間距；非頂層用同寬空盒讓 F 數字對齊。
  const trophyBox = isTop
    ? `<div style="display:flex;width:24px;justify-content:center;">🏆</div>`
    : `<div style="display:flex;width:24px;"></div>`;
  const reached = reachMultiplier(state, floor);
  const multColor = isCurrent
    ? PAL_BASE.accent
    : floor < state.currentFloor
      ? PAL_BASE.ink
      : PAL_BASE.muted;
  const marker = isCurrent
    ? `<div style="display:flex;font-size:18px;margin-right:2px;">👉</div>`
    : `<div style="display:flex;width:20px;"></div>`;

  const rowBg = isCurrent ? "background:rgba(255,216,77,0.08);" : "";

  return `<div style="display:flex;flex-direction:row;align-items:center;justify-content:center;${rowBg}padding:3px 0;">
      ${marker}
      <div style="display:flex;flex-direction:row;align-items:center;width:${LABEL_W}px;margin-right:14px;font-family:'SpaceMono';font-weight:700;font-size:18px;color:${labelColor};">${trophyBox}<div style="display:flex;margin-left:8px;">F${floor + 1}</div></div>
      <div style="display:flex;flex-direction:row;gap:${TILE_GAP}px;">${tiles.join("")}</div>
      <div style="display:flex;width:${MULT_W}px;margin-left:18px;justify-content:flex-end;">${prefixNum("×", reached.toFixed(2), multColor, 18)}</div>
    </div>`;
}

function buildMarkup(state, opts) {
  const { username, balance, diffLabel, cardW, cardH } = opts;
  const playing = state.status === "playing";
  const tint =
    playing ? TINT.play : state.result === "lose" ? TINT.lose : TINT.win;
  const P = PAL_BASE;

  let headline;
  if (playing) {
    headline = `第 ${state.currentFloor + 1} 層`;
  } else if (state.result === "lose") {
    headline = `止步第 ${state.currentFloor + 1} 層`;
  } else if (state.result === "win") {
    headline = `登頂成功 ×${state.accMultiplier.toFixed(2)}`;
  } else {
    headline = `收手 ×${state.accMultiplier.toFixed(2)}`;
  }

  const floors = [];
  for (let f = state.maxFloors - 1; f >= 0; f -= 1) {
    floors.push(floorRow(state, f));
  }

  // 頁尾右側依狀態切換：遊戲中顯示收手可拿，結算顯示淨輸贏 + 餘額。
  let footRight;
  if (playing) {
    const cash =
      state.currentFloor > 0
        ? Math.floor(state.bet * state.accMultiplier + 1e-9)
        : 0;
    footRight = `
      <div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:22px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">累積倍率</div>
        <div style="display:flex;margin-top:2px;">${prefixNum("×", state.accMultiplier.toFixed(2), P.accent, 22)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">收手可拿</div>
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;">${cash.toLocaleString()}</div>
      </div>`;
  } else {
    const net = (state.payout || 0) - state.bet;
    const sign = net > 0 ? "＋" : net < 0 ? "－" : "±";
    footRight = `
      <div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:22px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">淨輸贏</div>
        <div style="display:flex;margin-top:2px;">${prefixNum(sign, Math.abs(net).toLocaleString(), tint.headline, 22)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">餘額</div>
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;">${typeof balance === "number" ? balance.toLocaleString() : "—"}</div>
      </div>`;
  }

  return `
    <div style="display:flex;width:${cardW}px;height:${cardH}px;background:${P.bg};padding:${PAD}px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${tint.glow};border:3px solid ${P.ink};padding:22px ${INNER_PAD_X}px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:54px;height:54px;background:${P.accent};align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:700;font-size:20px;color:${P.bg};">TW</div>
            <div style="display:flex;margin-left:16px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${P.ink};letter-spacing:6px;padding-right:6px;">爬 塔</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 14px;background:${P.ink};font-family:'NotoSansTC';font-weight:500;font-size:15px;color:${P.bg};letter-spacing:3px;padding-right:18px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:12px;border-top:2px dashed ${P.muted};"></div>

        <div style="display:flex;flex-direction:row;width:100%;justify-content:center;align-items:center;margin-top:14px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${tint.headline};letter-spacing:3px;padding-right:3px;">${headline}</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${P.muted};letter-spacing:2px;margin-left:14px;padding-right:2px;">${diffLabel}</div>
        </div>

        <div style="display:flex;flex-direction:column;width:100%;margin-top:20px;gap:${ROW_GAP}px;">
          ${floors.join("")}
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:26px;border-top:2px dashed ${P.muted};">
          <div style="display:flex;flex-direction:column;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:20px;color:${P.ink};letter-spacing:2px;padding-right:2px;">${username || "玩家"}</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;margin-top:3px;padding-right:2px;">下注 ${state.bet.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            ${footRight}
          </div>
        </div>

      </div>
    </div>
  `;
}

async function generateTowerCard(state, opts = {}) {
  const boardInnerW =
    20 + LABEL_W + state.tilesPerFloor * TILE_W + (state.tilesPerFloor - 1) * TILE_GAP + MULT_W;
  const contentW = Math.max(boardInnerW, 460);
  const cardW = contentW + (PAD + BORDER + INNER_PAD_X) * 2;
  const floorsH = state.maxFloors * (TILE_H + 6 + ROW_GAP);
  const cardH = floorsH + 366; // 頁首 + 標題 + 頁尾 + 上下留白
  const markup = buildMarkup(state, { ...opts, cardW, cardH });
  return renderCard({ markup, width: cardW, height: cardH });
}

module.exports = generateTowerCard;
