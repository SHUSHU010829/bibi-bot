// 德州撲克桌面圖卡（公牌 + 玩家列）。
// 取材自 generateBlackjackCard 的 satori 風格，保持與 21 點圖卡相近的視覺。

const { totalPot } = require("../features/casino/poker/engine");
const { categoryLabel } = require("../features/casino/poker/hand");
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
  empty: "#D9CFB6",
};

const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

const SUIT_PATHS = {
  S: "M50 5 C32 28 8 42 8 58 C8 72 20 80 32 80 C40 80 46 75 49 68 L42 95 L58 95 L51 68 C54 75 60 80 68 80 C80 80 92 72 92 58 C92 42 68 28 50 5 Z",
  H: "M50 90 C20 65 5 50 5 30 C5 16 16 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C84 5 95 16 95 30 C95 50 80 65 50 90 Z",
  D: "M50 5 L92 50 L50 95 L8 50 Z",
  C: "M50 5 C40 5 32 13 32 23 C32 28 34 32 37 35 C26 33 8 38 8 52 C8 64 20 72 34 72 C42 72 48 68 50 62 C52 68 58 72 66 72 C80 72 92 64 92 52 C92 38 74 33 63 35 C66 32 68 28 68 23 C68 13 60 5 50 5 Z M40 92 L60 92 L55 72 L45 72 Z",
};

function isRedSuit(suit) {
  return suit === "H" || suit === "D";
}

function renderSuitSvg(suit, size, color) {
  const p = SUIT_PATHS[suit];
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${p}" fill="${color}"/></svg>`;
}

function renderCard(card, opts = {}) {
  const w = opts.width || 96;
  const h = opts.height || 138;
  if (!card) {
    const placeholderText = opts.placeholderText || "";
    return `
      <div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.empty};border:2px dashed ${PALETTE.muted};box-sizing:border-box;margin:0 6px;align-items:center;justify-content:center;">
        ${
          placeholderText
            ? `<div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${PALETTE.muted};letter-spacing:2px;">${placeholderText}</div>`
            : ""
        }
      </div>
    `;
  }
  const rank = card[0];
  const suit = card[1];
  const label = RANK_LABEL[rank] || rank;
  const color = isRedSuit(suit) ? PALETTE.red : PALETTE.ink;
  const suitSvg = renderSuitSvg(suit, 48, color);
  const rankSize = label.length > 1 ? 44 : 52;
  return `
    <div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.cardWhite};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 6px;flex-direction:column;justify-content:center;align-items:center;padding:8px 0;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;letter-spacing:-2px;">${label}</div>
      <div style="display:flex;margin-top:10px;">${suitSvg}</div>
    </div>
  `;
}

// 玩家小卡（用於 showdown 顯示底牌）
function renderMiniCard(card) {
  const w = 38;
  const h = 54;
  if (!card) return "";
  const rank = card[0];
  const suit = card[1];
  const label = RANK_LABEL[rank] || rank;
  const color = isRedSuit(suit) ? PALETTE.red : PALETTE.ink;
  const suitSvg = renderSuitSvg(suit, 20, color);
  const rankSize = label.length > 1 ? 16 : 20;
  return `
    <div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};box-sizing:border-box;margin:0 2px;flex-direction:column;justify-content:center;align-items:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;">${label}</div>
      <div style="display:flex;margin-top:2px;">${suitSvg}</div>
    </div>
  `;
}

function phaseLabel(phase) {
  const map = {
    preflop: "PRE-FLOP",
    flop: "FLOP",
    turn: "TURN",
    river: "RIVER",
    showdown: "SHOWDOWN",
  };
  return map[phase] || (phase || "WAITING");
}

function badgeFor(p, idx, state, settledScores) {
  const tags = [];
  if (state.buttonIdx === idx) tags.push({ t: "D", c: PALETTE.gold });
  if (state.sbIdx === idx) tags.push({ t: "SB", c: PALETTE.muted });
  if (state.bbIdx === idx) tags.push({ t: "BB", c: PALETTE.muted });
  if (p.allIn) tags.push({ t: "ALL-IN", c: PALETTE.red });
  if (p.folded) tags.push({ t: "FOLD", c: PALETTE.neutral });
  if (state.toActIdx === idx && state.status === "playing")
    tags.push({ t: "TO ACT", c: PALETTE.teal });
  if (settledScores) {
    const s = settledScores.find((x) => x.userId === p.userId);
    if (s && s.score) tags.push({ t: categoryLabel(s.score), c: PALETTE.gold });
  }
  if (tags.length === 0) return "";
  return tags
    .map(
      ({ t, c }) =>
        `<div style="display:flex;margin-left:6px;padding:2px 8px;background:${c};color:${PALETTE.cardWhite};font-family:'SpaceMono';font-size:12px;letter-spacing:2px;line-height:1.4;">${t}</div>`
    )
    .join("");
}

function buildMarkup(state) {
  const community = state.community || [];
  const placeholders = ["翻", "牌", "等", "待", "中"];
  const isPreflop = state.phase === "preflop" || state.phase === null;
  const communityRow = [0, 1, 2, 3, 4]
    .map((i) =>
      renderCard(community[i] || null, {
        placeholderText: isPreflop && state.status === "playing" ? placeholders[i] : "",
      })
    )
    .join("");

  const pot = totalPot(state);
  const phase = phaseLabel(state.phase);
  const handNo = state.handNumber || 0;

  const settledScores = state.settle?.scores || null;

  // 玩家分兩列（上下），最多 8 人
  const players = state.players.slice(0, 8);
  const renderPlayer = (p, idx) => {
    const isWinner =
      state.settle?.winners?.some((pot) =>
        pot.splits.some((s) => s.userId === p.userId)
      ) || false;
    const nameColor = isWinner ? PALETTE.gold : PALETTE.ink;
    const wonAmount = state.settle
      ? state.settle.winners.reduce((sum, pot) => {
          const s = pot.splits.find((x) => x.userId === p.userId);
          return sum + (s?.amount || 0);
        }, 0)
      : 0;
    // showdown 時把未棄牌玩家的底牌畫出來（小卡）
    const showHoles =
      state.status === "settled" &&
      state.settle?.showdown &&
      !p.folded &&
      Array.isArray(p.holeCards) &&
      p.holeCards.length === 2;
    const holesHtml = showHoles
      ? `<div style="display:flex;margin-left:auto;align-items:center;">${renderMiniCard(p.holeCards[0])}${renderMiniCard(p.holeCards[1])}</div>`
      : "";
    return `
      <div style="display:flex;flex-direction:column;width:300px;height:96px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};box-sizing:border-box;padding:10px 14px;margin:6px;">
        <div style="display:flex;align-items:center;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${nameColor};letter-spacing:1px;line-height:1.2;padding-right:4px;">@${p.username || "player"}</div>
          ${badgeFor(p, idx, state, settledScores)}
          ${holesHtml}
        </div>
        <div style="display:flex;align-items:flex-end;margin-top:8px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:3px;color:${PALETTE.muted};line-height:1;padding-right:3px;">CHIPS</div>
          <div style="display:flex;margin-left:6px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${(p.chips || 0).toLocaleString()}</div>
          ${
            p.bet > 0
              ? `<div style="display:flex;margin-left:18px;font-family:'SpaceMono';font-size:11px;letter-spacing:3px;color:${PALETTE.muted};line-height:1;padding-right:3px;">BET</div>
                 <div style="display:flex;margin-left:6px;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.teal};line-height:1;">${p.bet.toLocaleString()}</div>`
              : ""
          }
          ${
            wonAmount > 0
              ? `<div style="display:flex;margin-left:auto;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${PALETTE.gold};line-height:1;padding-left:6px;">+${wonAmount.toLocaleString()}</div>`
              : ""
          }
        </div>
      </div>
    `;
  };

  const playersGrid = players.map(renderPlayer).join("");

  return `
    <div style="display:flex;width:1080px;height:880px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 40px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${PALETTE.teal};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:24px;color:${PALETTE.card};letter-spacing:-1px;">PK</div>
            <div style="display:flex;margin-left:18px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.ink};letter-spacing:5px;padding-right:5px;">TEXAS HOLD'EM</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 16px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${PALETTE.card};letter-spacing:3px;padding-right:17px;">第 ${handNo} 局 ・ ${phase}</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;justify-content:center;margin-top:24px;">${communityRow}</div>

        <div style="display:flex;width:100%;justify-content:center;align-items:center;margin-top:20px;">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">POT</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.gold};line-height:1;">${pot.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;margin-left:48px;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">CALL</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;">${(state.currentBet || 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;margin-left:48px;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">SB / BB</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:20px;color:${PALETTE.ink};line-height:1;">${state.smallBlind}/${state.bigBlind}</div>
          </div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:18px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;flex-wrap:wrap;justify-content:center;margin-top:14px;">${playersGrid}</div>

        <div style="display:flex;width:100%;justify-content:flex-end;margin-top:auto;padding-top:12px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${PALETTE.muted};padding-right:4px;">逼逼賭場 · POKER ROOM</div>
        </div>

      </div>
    </div>
  `;
}

async function generatePokerCard(state) {
  const markup = buildMarkup(state);
  return renderCardToPng({ markup, width: 1080, height: 880 });
}

module.exports = generatePokerCard;
