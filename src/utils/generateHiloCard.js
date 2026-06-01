const { calcOdds, valueOf } = require("../features/casino/hilo/engine");
const { renderCard: renderCardToPng } = require("./cardRenderer");

const PALETTE = {
  card: "#F4ECD8",
  ink: "#2A2420",
  muted: "#A89270",
  cardWhite: "#FBF7EC",
  red: "#C9302C",
  teal: "#3D6F6A",
  gold: "#D4A437",
  neutral: "#5C5648",
  hidden: "#C9302C",
};

const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function isRedSuit(suit) {
  return suit === "H" || suit === "D";
}

const SUIT_PATHS = {
  S: "M50 5 C32 28 8 42 8 58 C8 72 20 80 32 80 C40 80 46 75 49 68 L42 95 L58 95 L51 68 C54 75 60 80 68 80 C80 80 92 72 92 58 C92 42 68 28 50 5 Z",
  H: "M50 90 C20 65 5 50 5 30 C5 16 16 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C84 5 95 16 95 30 C95 50 80 65 50 90 Z",
  D: "M50 5 L92 50 L50 95 L8 50 Z",
  C: "M50 5 C40 5 32 13 32 23 C32 28 34 32 37 35 C26 33 8 38 8 52 C8 64 20 72 34 72 C42 72 48 68 50 62 C52 68 58 72 66 72 C80 72 92 64 92 52 C92 38 74 33 63 35 C66 32 68 28 68 23 C68 13 60 5 50 5 Z M40 92 L60 92 L55 72 L45 72 Z",
};

function renderSuitSvg(suit, size, color) {
  const p = SUIT_PATHS[suit];
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${p}" fill="${color}"/></svg>`;
}

function renderCard(card, size = "lg") {
  const rank = card[0];
  const suit = card[1];
  const label = RANK_LABEL[rank];
  const color = isRedSuit(suit) ? PALETTE.red : PALETTE.ink;
  const dims =
    size === "lg"
      ? { w: 180, h: 252, rank: 100, suit: 84, pad: 18 }
      : { w: 120, h: 168, rank: 64, suit: 56, pad: 12 };
  const rankSize = label.length > 1 ? Math.floor(dims.rank * 0.85) : dims.rank;
  return `
    <div style="display:flex;width:${dims.w}px;height:${dims.h}px;background:${PALETTE.cardWhite};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 8px;flex-direction:column;justify-content:center;align-items:center;padding:${dims.pad}px 0;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;letter-spacing:-2px;">${label}</div>
      <div style="display:flex;margin-top:18px;">${renderSuitSvg(suit, dims.suit, color)}</div>
    </div>
  `;
}

function renderHiddenCard(size = "lg") {
  const dims =
    size === "lg"
      ? { w: 180, h: 252, q: 120 }
      : { w: 120, h: 168, q: 80 };
  return `
    <div style="display:flex;width:${dims.w}px;height:${dims.h}px;background:${PALETTE.hidden};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 8px;align-items:center;justify-content:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${dims.q}px;color:${PALETTE.cardWhite};line-height:1;">?</div>
    </div>
  `;
}

function pickAccent(state) {
  if (state.status !== "settled") return PALETTE.muted;
  if (state.result === "cashout" || state.result === "win") return PALETTE.gold;
  return PALETTE.muted;
}

function buildResultLabel(state) {
  if (state.status !== "settled") return null;
  switch (state.result) {
    case "cashout":
      return { text: "收手成功", color: PALETTE.gold };
    case "win":
      return { text: "滿關獎勵", color: PALETTE.gold };
    case "lose":
    default:
      return { text: "猜錯了", color: PALETTE.red };
  }
}

function renderCheckSvg(size, color) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M20 52 L42 74 L82 28" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderCrossSvg(size, color) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M22 22 L78 78 M78 22 L22 78" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/></svg>`;
}

function renderHistoryStrip(history) {
  if (!history || history.length === 0) return "";
  // 只顯示最後 6 把，避免畫面爆掉
  const tail = history.slice(-6);
  const items = tail
    .map((h) => {
      const okColor = h.correct ? PALETTE.teal : PALETTE.red;
      const okSvg = h.correct
        ? renderCheckSvg(20, okColor)
        : renderCrossSvg(20, okColor);
      const cardLabel = h.drawn
        ? `${RANK_LABEL[h.drawn[0]]}${
            { S: "♠", H: "♥", D: "♦", C: "♣" }[h.drawn[1]]
          }`
        : "—";
      const guessLabel = h.guess.toUpperCase();
      return `
        <div style="display:flex;flex-direction:column;align-items:center;margin:0 6px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:2px;color:${PALETTE.muted};line-height:1;padding-right:2px;">${guessLabel}</div>
          <div style="display:flex;align-items:center;justify-content:center;width:46px;height:46px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${PALETTE.ink};line-height:1;">${cardLabel}</div>
          <div style="display:flex;margin-top:6px;">${okSvg}</div>
        </div>
      `;
    })
    .join("");
  return `<div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:16px;">${items}</div>`;
}

function buildMarkup(data) {
  const { username, state, balance } = data;
  const isPlaying = state.status === "playing";
  const accent = pickAccent(state);
  const resultLabel = buildResultLabel(state);
  const handle = `@${(username || "shushu").toUpperCase()}`;
  const baseVal = valueOf(state.baseCard);

  const odds = isPlaying
    ? calcOdds(state.baseCard, state.deck, state.houseEdge)
    : null;

  const fmtMul = (x) => (x > 0 ? `×${x.toFixed(2)}` : "×—");

  // 中央兩張牌：底牌 + 下一張（playing 時下一張為 ?；settled 時若有 history 顯示最後一張）
  const last = state.history[state.history.length - 1];
  const showNext = !isPlaying && last && last.drawn;
  const nextCard = showNext ? renderCard(last.drawn, "lg") : renderHiddenCard("lg");

  // 用 SVG 畫上下箭頭，避免 ⬆⬇ 在 NotoSansTC / SpaceMono 都沒 glyph 變豆腐
  const upArrow = `<svg width="14" height="14" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 14 L86 56 L66 56 L66 88 L34 88 L34 56 L14 56 Z" fill="${PALETTE.teal}"/></svg>`;
  const downArrow = `<svg width="14" height="14" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 86 L86 44 L66 44 L66 12 L34 12 L34 44 L14 44 Z" fill="${PALETTE.red}"/></svg>`;
  const eqMark = `<svg width="14" height="14" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="34" width="72" height="12" fill="${PALETTE.gold}"/><rect x="14" y="56" width="72" height="12" fill="${PALETTE.gold}"/></svg>`;

  const oddsBlock = isPlaying
    ? `
      <div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:18px;">
        <div style="display:flex;flex-direction:column;align-items:center;margin:0 16px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
          <div style="display:flex;align-items:center;line-height:1;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:6px;">HI</div>
            <div style="display:flex;">${upArrow}</div>
          </div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.teal};line-height:1;margin-top:6px;">${fmtMul(odds.multipliers.hi)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;margin:0 16px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
          <div style="display:flex;align-items:center;line-height:1;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:6px;">SAME</div>
            <div style="display:flex;">${eqMark}</div>
          </div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.gold};line-height:1;margin-top:6px;">${fmtMul(odds.multipliers.same)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;margin:0 16px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
          <div style="display:flex;align-items:center;line-height:1;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:6px;">LO</div>
            <div style="display:flex;">${downArrow}</div>
          </div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.red};line-height:1;margin-top:6px;">${fmtMul(odds.multipliers.lo)}</div>
        </div>
      </div>
    `
    : "";

  let settleAmount = 0;
  let settleAmountPrefix = "";
  if (state.result === "lose") {
    settleAmount = state.bet;
    settleAmountPrefix = "−";
  } else if (state.payout > 0) {
    settleAmount = state.payout;
    settleAmountPrefix = "+";
  }

  const resultBlock = resultLabel
    ? `
      <div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:18px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${resultLabel.color};letter-spacing:10px;line-height:1;padding-right:10px;">${resultLabel.text}</div>
        ${
          settleAmount > 0
            ? `<div style="display:flex;align-items:flex-end;margin-left:48px;">
                 <div style="display:flex;font-family:'SpaceMono';font-weight:400;font-size:22px;color:${resultLabel.color};line-height:1;margin-right:10px;margin-bottom:4px;">${settleAmountPrefix}</div>
                 <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${resultLabel.color};line-height:1;">${settleAmount.toLocaleString()}</div>
               </div>`
            : ""
        }
      </div>
    `
    : `
      <div style="display:flex;flex-direction:column;align-items:center;width:100%;margin-top:14px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.muted};letter-spacing:6px;line-height:1;padding-right:6px;">猜下一張比 ${baseVal} 大、小、還是相同？</div>
      </div>
    `;

  const accLabel = state.accMultiplier
    ? `×${state.accMultiplier.toFixed(2)}`
    : "×1.00";

  const cashOutLabel = isPlaying && state.wins > 0
    ? `${Math.floor(state.bet * state.accMultiplier + 1e-9).toLocaleString()}`
    : "—";

  return `
    <div style="display:flex;width:1080px;height:920px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 40px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${accent};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:22px;color:${PALETTE.card};letter-spacing:-1px;">HL</div>
            <div style="display:flex;margin-left:18px;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${PALETTE.ink};letter-spacing:6px;padding-right:6px;">HI - LO</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 16px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${PALETTE.card};letter-spacing:3px;padding-right:19px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;justify-content:space-around;align-items:center;margin-top:30px;">
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">底牌</div>
            <div style="display:flex;margin-top:14px;">${renderCard(state.baseCard, "lg")}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">下一張</div>
            <div style="display:flex;margin-top:14px;">${nextCard}</div>
          </div>
        </div>

        ${oddsBlock}

        ${renderHistoryStrip(state.history)}

        ${resultBlock}

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:20px;border-top:2px dashed ${PALETTE.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${state.bet.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">STREAK</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${state.wins} ・ ${accLabel}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">CASH OUT</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${cashOutLabel}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BAL</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${(balance ?? 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:5px;color:${PALETTE.ink};padding-right:5px;">${handle}</div>
        </div>

      </div>
    </div>
  `;
}

async function generateHiloCard(data) {
  const markup = buildMarkup(data);
  return renderCardToPng({ markup, width: 1080, height: 920 });
}

module.exports = generateHiloCard;
