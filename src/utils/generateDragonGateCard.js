const { classifyDeck, valueOf } = require("../features/casino/dragonGate/engine");
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

const CARD_DIMS = { w: 180, h: 252, rank: 100, suit: 84, pad: 18, suitGap: 18 };

function renderCard(card) {
  const rank = card[0];
  const suit = card[1];
  const label = RANK_LABEL[rank];
  const color = isRedSuit(suit) ? PALETTE.red : PALETTE.ink;
  const rankSize = label.length > 1 ? Math.floor(CARD_DIMS.rank * 0.85) : CARD_DIMS.rank;
  return `
    <div style="display:flex;width:${CARD_DIMS.w}px;height:${CARD_DIMS.h}px;background:${PALETTE.cardWhite};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 8px;flex-direction:column;justify-content:center;align-items:center;padding:${CARD_DIMS.pad}px 0;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;letter-spacing:-2px;">${label}</div>
      <div style="display:flex;margin-top:${CARD_DIMS.suitGap}px;">${renderSuitSvg(suit, CARD_DIMS.suit, color)}</div>
    </div>
  `;
}

function renderHiddenCard() {
  return `
    <div style="display:flex;width:${CARD_DIMS.w}px;height:${CARD_DIMS.h}px;background:${PALETTE.hidden};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 8px;align-items:center;justify-content:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:120px;color:${PALETTE.cardWhite};line-height:1;">?</div>
    </div>
  `;
}

function renderEmptySlot() {
  return `
    <div style="display:flex;width:${CARD_DIMS.w}px;height:${CARD_DIMS.h}px;background:${PALETTE.card};border:3px dashed ${PALETTE.muted};box-sizing:border-box;margin:0 8px;align-items:center;justify-content:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${PALETTE.muted};letter-spacing:4px;line-height:1;padding-right:4px;">棄 權</div>
    </div>
  `;
}

function pickAccent(state) {
  if (state.status !== "settled") return PALETTE.muted;
  switch (state.result) {
    case "between":
      return PALETTE.gold;
    case "outside":
      return PALETTE.muted;
    case "hitGate":
      return PALETTE.red;
    case "fold":
      return PALETTE.neutral;
    default:
      return PALETTE.muted;
  }
}

function buildResultLabel(state) {
  if (state.status !== "settled") return null;
  switch (state.result) {
    case "between":
      return { text: "射中龍門", color: PALETTE.gold };
    case "outside":
      return { text: "射出柱外", color: PALETTE.muted };
    case "hitGate":
      return { text: "碰柱賠雙", color: PALETTE.red };
    case "fold":
      return { text: "棄權不補", color: PALETTE.neutral };
    default:
      return null;
  }
}

function renderProbsBlock(state) {
  const cls = classifyDeck(state.gateLow, state.gateHigh, state.deck);
  const total = cls.total || 1;
  const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;
  return `
    <div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:24px;">
      <div style="display:flex;flex-direction:column;align-items:center;margin:0 14px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:4px;">中間</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.gold};line-height:1;margin-top:6px;">×${state.multiplier.toFixed(2)}</div>
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:2px;color:${PALETTE.muted};line-height:1;margin-top:4px;padding-right:2px;">${cls.between}/${total} ${pct(cls.between)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;margin:0 14px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:4px;">外面</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.muted};line-height:1;margin-top:6px;">−1×</div>
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:2px;color:${PALETTE.muted};line-height:1;margin-top:4px;padding-right:2px;">${cls.outside}/${total} ${pct(cls.outside)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;margin:0 14px;padding:8px 22px;background:${PALETTE.cardWhite};border:2px solid ${PALETTE.ink};">
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:4px;">碰柱</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.red};line-height:1;margin-top:6px;">−2×</div>
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:2px;color:${PALETTE.muted};line-height:1;margin-top:4px;padding-right:2px;">${cls.hit}/${total} ${pct(cls.hit)}</div>
      </div>
    </div>
  `;
}

function buildMarkup(data) {
  const { username, state, balance } = data;
  const awaiting = state.status === "awaitingChoice";
  const accent = pickAccent(state);
  const resultLabel = buildResultLabel(state);
  const handle = `@${(username || "shushu").toUpperCase()}`;

  const lowVal = valueOf(state.gateLow);
  const highVal = valueOf(state.gateHigh);

  // 中央第三張：awaitingChoice → ?；有 thirdCard → 該牌；fold → 空槽
  let middleSlot;
  if (awaiting) {
    middleSlot = renderHiddenCard();
  } else if (state.thirdCard) {
    middleSlot = renderCard(state.thirdCard);
  } else {
    middleSlot = renderEmptySlot();
  }

  // 中央區：左柱 [ 第三張 ] 右柱
  const gatesRow = `
    <div style="display:flex;width:100%;justify-content:center;align-items:center;margin-top:28px;">
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">左柱</div>
        <div style="display:flex;margin-top:10px;">${renderCard(state.gateLow)}</div>
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:18px;letter-spacing:2px;color:${PALETTE.ink};line-height:1;padding-right:2px;">${lowVal}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;margin:0 8px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">${awaiting ? "第三張" : (state.thirdCard ? "開牌" : "—")}</div>
        <div style="display:flex;margin-top:10px;">${middleSlot}</div>
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:18px;letter-spacing:2px;color:${PALETTE.ink};line-height:1;padding-right:2px;">${state.thirdCard ? valueOf(state.thirdCard) : "?"}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">右柱</div>
        <div style="display:flex;margin-top:10px;">${renderCard(state.gateHigh)}</div>
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:18px;letter-spacing:2px;color:${PALETTE.ink};line-height:1;padding-right:2px;">${highVal}</div>
      </div>
    </div>
  `;

  // 機率 / 賠率區（awaitingChoice 才顯示）
  const probsBlock = awaiting && state.deck && state.deck.length > 0
    ? renderProbsBlock(state)
    : "";

  // 結算金額
  let settleAmount = 0;
  let settleAmountPrefix = "";
  if (state.result === "between") {
    const profit = (state.payout || 0) - (state.lock || state.bet * 2);
    settleAmount = profit;
    settleAmountPrefix = "+";
  } else if (state.result === "outside") {
    settleAmount = state.bet;
    settleAmountPrefix = "−";
  } else if (state.result === "hitGate") {
    settleAmount = state.bet * 2;
    settleAmountPrefix = "−";
  } else if (state.result === "fold") {
    settleAmount = state.ante || 0;
    settleAmountPrefix = "−";
  }

  const resultBlock = resultLabel
    ? `
      <div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:28px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:42px;color:${resultLabel.color};letter-spacing:10px;line-height:1;padding-right:10px;">${resultLabel.text}</div>
        ${
          settleAmount > 0
            ? `<div style="display:flex;align-items:flex-end;margin-left:40px;">
                 <div style="display:flex;font-family:'SpaceMono';font-weight:400;font-size:22px;color:${resultLabel.color};line-height:1;margin-right:10px;margin-bottom:4px;">${settleAmountPrefix}</div>
                 <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:42px;color:${resultLabel.color};line-height:1;">${settleAmount.toLocaleString()}</div>
               </div>`
            : ""
        }
      </div>
    `
    : `
      <div style="display:flex;flex-direction:column;align-items:center;width:100%;margin-top:18px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:20px;color:${PALETTE.muted};letter-spacing:6px;line-height:1;padding-right:6px;">補：下注後開第三張　不補：棄權損失入場費</div>
      </div>
    `;

  const multLabel = state.multiplier && state.multiplier > 0
    ? `×${state.multiplier.toFixed(2)}`
    : "—";

  return `
    <div style="display:flex;width:1080px;height:920px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 40px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${accent};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:24px;color:${PALETTE.card};letter-spacing:-1px;">DG</div>
            <div style="display:flex;margin-left:18px;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${PALETTE.ink};letter-spacing:6px;padding-right:6px;">射龍門</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 16px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${PALETTE.card};letter-spacing:3px;padding-right:19px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        ${gatesRow}

        ${probsBlock}

        ${resultBlock}

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:20px;border-top:2px dashed ${PALETTE.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">ANTE</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${(state.ante || 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${(state.bet || 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">MULT</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${multLabel}</div>
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

async function generateDragonGateCard(data) {
  const markup = buildMarkup(data);
  return renderCardToPng({ markup, width: 1080, height: 920 });
}

module.exports = generateDragonGateCard;
