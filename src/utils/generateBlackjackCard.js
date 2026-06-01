const { evaluateHand } = require("../features/casino/blackjack/hand");
const {
  FIVE_CARD_THRESHOLD,
} = require("../features/casino/blackjack/engine");
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

// 內嵌 SVG 畫四種花色（NotoSansTC 沒有 ♠♥♦♣ glyph，satori 會直接吞掉）
const SUIT_PATHS = {
  S: "M50 5 C32 28 8 42 8 58 C8 72 20 80 32 80 C40 80 46 75 49 68 L42 95 L58 95 L51 68 C54 75 60 80 68 80 C80 80 92 72 92 58 C92 42 68 28 50 5 Z",
  H: "M50 90 C20 65 5 50 5 30 C5 16 16 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C84 5 95 16 95 30 C95 50 80 65 50 90 Z",
  D: "M50 5 L92 50 L50 95 L8 50 Z",
  C: "M50 5 C40 5 32 13 32 23 C32 28 34 32 37 35 C26 33 8 38 8 52 C8 64 20 72 34 72 C42 72 48 68 50 62 C52 68 58 72 66 72 C80 72 92 64 92 52 C92 38 74 33 63 35 C66 32 68 28 68 23 C68 13 60 5 50 5 Z M40 92 L60 92 L55 72 L45 72 Z",
};

function renderSuitSvg(suit, size, color) {
  const path = SUIT_PATHS[suit];
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="${color}"/></svg>`;
}

function pickAccent(state) {
  if (state.status !== "settled") return PALETTE.muted;
  switch (state.result) {
    case "blackjack":
      return PALETTE.gold;
    case "fivecard":
      return PALETTE.gold;
    case "dealerfivecard":
      return PALETTE.muted;
    case "win":
      return PALETTE.teal;
    case "push":
      return PALETTE.neutral;
    case "lose":
    default:
      return PALETTE.muted;
  }
}

const CARD_SIZE_DEFAULT = { w: 140, h: 200, suit: 72, rank: 80, rank2: 70, margin: 8, padding: 14, suitGap: 20, hiddenRank: 96 };
const CARD_SIZE_SMALL   = { w: 84,  h: 120, suit: 44, rank: 48, rank2: 42, margin: 4, padding: 8,  suitGap: 10, hiddenRank: 58 };

function renderCard(card, sz = CARD_SIZE_DEFAULT) {
  const rank = card[0];
  const suit = card[1];
  const label = RANK_LABEL[rank];
  const color = isRedSuit(suit) ? PALETTE.red : PALETTE.ink;
  const suitSvg = renderSuitSvg(suit, sz.suit, color);
  // 10 兩個字母排起來會超寬，把字級縮一點
  const rankSize = label.length > 1 ? sz.rank2 : sz.rank;
  return `
    <div style="display:flex;width:${sz.w}px;height:${sz.h}px;background:${PALETTE.cardWhite};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 ${sz.margin}px;flex-direction:column;justify-content:center;align-items:center;padding:${sz.padding}px 0;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;letter-spacing:-2px;">${label}</div>
      <div style="display:flex;margin-top:${sz.suitGap}px;">${suitSvg}</div>
    </div>
  `;
}

function renderHiddenCard(sz = CARD_SIZE_DEFAULT) {
  return `
    <div style="display:flex;width:${sz.w}px;height:${sz.h}px;background:${PALETTE.hidden};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 ${sz.margin}px;align-items:center;justify-content:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${sz.hiddenRank}px;color:${PALETTE.cardWhite};line-height:1;">?</div>
    </div>
  `;
}

function renderHandRow(cards, hideSecond, sz = CARD_SIZE_DEFAULT) {
  return cards
    .map((c, i) => (hideSecond && i === 1 ? renderHiddenCard(sz) : renderCard(c, sz)))
    .join("");
}

function buildResultLabel(state) {
  if (state.status !== "settled") return null;
  switch (state.result) {
    case "blackjack":
      return { text: "BLACKJACK", color: PALETTE.gold };
    case "fivecard":
      return { text: "過五關", color: PALETTE.gold };
    case "dealerfivecard":
      return { text: "莊家過五關", color: PALETTE.muted };
    case "win":
      return { text: "玩家獲勝", color: PALETTE.teal };
    case "push":
      return { text: "平手", color: PALETTE.neutral };
    case "lose":
    default:
      return { text: "莊家獲勝", color: PALETTE.muted };
  }
}

function renderBadge(text, bg, fg) {
  return `<div style="display:flex;margin-left:14px;padding:2px 10px;background:${bg};color:${fg};font-family:'SpaceMono';font-size:14px;letter-spacing:2px;">${text}</div>`;
}

function handBadge(hand, ev, allowBJ) {
  if (ev.isBust) return renderBadge("BUST", PALETTE.red, PALETTE.cardWhite);
  if (hand.cards.length >= FIVE_CARD_THRESHOLD) return renderBadge("5-CARD", PALETTE.gold, PALETTE.ink);
  if (allowBJ && ev.isBlackjack && hand.cards.length === 2) {
    return renderBadge("BJ", PALETTE.gold, PALETTE.ink);
  }
  return "";
}

function handResultBadge(hand) {
  const stake = hand.bet * (hand.doubled ? 2 : 1);
  switch (hand.result) {
    case "blackjack":
      return { text: `BJ +${hand.payout.toLocaleString()}`, color: PALETTE.gold };
    case "fivecard":
      return { text: `5-CARD +${hand.payout.toLocaleString()}`, color: PALETTE.gold };
    case "win":
      return { text: `WIN +${hand.payout.toLocaleString()}`, color: PALETTE.teal };
    case "push":
      return { text: `PUSH 退 ${stake.toLocaleString()}`, color: PALETTE.neutral };
    case "dealerfivecard":
      return { text: `LOSE -${stake.toLocaleString()}`, color: PALETTE.muted };
    case "lose":
    default:
      return { text: `LOSE -${stake.toLocaleString()}`, color: PALETTE.muted };
  }
}

function buildMarkup(data) {
  const { username, state, balance } = data;
  const isPlaying = state.status === "playing";
  const accent = pickAccent(state);
  const resultLabel = buildResultLabel(state);

  const hands = Array.isArray(state.hands) && state.hands.length > 0
    ? state.hands
    : [{
        cards: state.playerHand,
        bet: state.bet,
        doubled: !!state.doubled,
        result: state.result,
        payout: state.payout,
        fromSplitAces: false,
      }];
  const isSplit = !!state.isSplit;
  const activeIndex = state.activeIndex ?? 0;

  const dealerEval = evaluateHand(state.dealerHand);
  const dealerVisibleTotal = isPlaying ? "?" : dealerEval.total;

  const handle = `@${(username || "shushu").toUpperCase()}`;
  const totalStake = hands.reduce(
    (s, h) => s + h.bet * (h.doubled ? 2 : 1),
    0
  );

  const dealerCards = renderHandRow(state.dealerHand, isPlaying);

  const dealerBadge = !isPlaying && dealerEval.isBust
    ? renderBadge("BUST", PALETTE.red, PALETTE.cardWhite)
    : !isPlaying && state.dealerHand.length >= FIVE_CARD_THRESHOLD
    ? renderBadge("5-CARD", PALETTE.muted, PALETTE.cardWhite)
    : !isPlaying && dealerEval.isBlackjack && state.dealerHand.length === 2
    ? renderBadge("BJ", PALETTE.gold, PALETTE.ink)
    : "";

  // 玩家手牌渲染：未分牌走原本大牌單列；分牌則兩欄並排小牌
  let playerSection;
  if (!isSplit) {
    const hand = hands[0];
    const ev = evaluateHand(hand.cards);
    const badge = handBadge(hand, ev, true);
    const cards = renderHandRow(hand.cards, false, CARD_SIZE_DEFAULT);
    playerSection = `
      <div style="display:flex;width:100%;align-items:center;margin-top:14px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">玩家</div>
        <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;">${ev.total}${ev.isSoft && !ev.isBust ? " (S)" : ""}</div>
        ${badge}
      </div>
      <div style="display:flex;width:100%;justify-content:center;margin-top:6px;">${cards}</div>
    `;
  } else {
    const cols = hands.map((hand, i) => {
      const ev = evaluateHand(hand.cards);
      const badge = handBadge(hand, ev, false); // split 後不認 BJ
      const cards = renderHandRow(hand.cards, false, CARD_SIZE_SMALL);
      const isActive = isPlaying && i === activeIndex;
      const borderColor = isActive ? PALETTE.gold : PALETTE.muted;
      const borderWidth = isActive ? 3 : 2;
      const headerMarker = isActive
        ? renderBadge("ACTIVE", PALETTE.gold, PALETTE.ink)
        : (!isPlaying ? "" : renderBadge("待打", PALETTE.muted, PALETTE.cardWhite));
      const resultBadge = !isPlaying && hand.result
        ? (() => {
            const r = handResultBadge(hand);
            return `<div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${r.color};letter-spacing:2px;line-height:1;padding-right:2px;">${r.text}</div>`;
          })()
        : "";
      return `
        <div style="display:flex;flex-direction:column;align-items:center;width:48%;padding:10px 8px;box-sizing:border-box;border:${borderWidth}px solid ${borderColor};">
          <div style="display:flex;align-items:center;width:100%;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:4px;">第 ${i + 1} 手</div>
            <div style="display:flex;margin-left:6px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${ev.total}${ev.isSoft && !ev.isBust ? " (S)" : ""}</div>
            ${badge || headerMarker}
          </div>
          <div style="display:flex;margin-top:6px;justify-content:center;">${cards}</div>
          ${resultBadge}
        </div>
      `;
    }).join("");

    playerSection = `
      <div style="display:flex;width:100%;align-items:center;margin-top:14px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">玩家・分牌</div>
      </div>
      <div style="display:flex;width:100%;justify-content:space-between;margin-top:8px;">${cols}</div>
    `;
  }

  // 結算金額：push = 退回本金、win/blackjack = 派彩、lose = 顯示輸掉的本金
  let settleAmount = 0;
  let settleAmountPrefix = "";
  if (state.result === "push" && !isSplit) {
    settleAmount = totalStake;
    settleAmountPrefix = "退回 ";
  } else if (state.result === "lose" && !isSplit) {
    settleAmount = totalStake;
    settleAmountPrefix = "−";
  } else if (state.payout > 0) {
    settleAmount = state.payout;
    settleAmountPrefix = "+";
  } else if (isSplit && !isPlaying) {
    settleAmount = totalStake;
    settleAmountPrefix = "−";
  }

  const playingActiveHand = hands[activeIndex] || hands[0];
  const playingActiveEval = evaluateHand(playingActiveHand.cards);

  const resultBlock = resultLabel
    ? `
      <div style="display:flex;flex-direction:row;align-items:center;justify-content:center;width:100%;margin-top:${isSplit ? 16 : 28}px;margin-bottom:${isSplit ? 24 : 48}px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${isSplit ? 32 : 42}px;color:${resultLabel.color};letter-spacing:10px;line-height:1;padding-right:10px;">${resultLabel.text}</div>
        ${
          settleAmount > 0
            ? `<div style="display:flex;align-items:flex-end;margin-left:40px;">
                 <div style="display:flex;font-family:'SpaceMono';font-weight:400;font-size:20px;color:${resultLabel.color};line-height:1;margin-right:10px;margin-bottom:4px;">${settleAmountPrefix}</div>
                 <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${isSplit ? 32 : 42}px;color:${resultLabel.color};line-height:1;">${settleAmount.toLocaleString()}</div>
               </div>`
            : ""
        }
      </div>
    `
    : (() => {
        const remain = FIVE_CARD_THRESHOLD - playingActiveHand.cards.length;
        const showFiveCardHint =
          remain > 0 && remain < FIVE_CARD_THRESHOLD - 2 && !playingActiveEval.isBust;
        let hintText;
        if (isSplit) {
          hintText = `輪到第 ${activeIndex + 1} 手`;
        } else if (showFiveCardHint) {
          hintText = `再抽 ${remain} 張未爆牌即過五關`;
        } else {
          hintText = "輪到你了";
        }
        const hintColor = showFiveCardHint ? PALETTE.gold : PALETTE.muted;
        return `
      <div style="display:flex;flex-direction:column;align-items:center;width:100%;margin-top:${isSplit ? 16 : 28}px;margin-bottom:${isSplit ? 24 : 48}px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${hintColor};letter-spacing:6px;line-height:1;padding-right:6px;">${hintText}</div>
      </div>
    `;
      })();

  const stakeLabel = isSplit
    ? `${state.bet.toLocaleString()} ×2手`
    : (hands[0].doubled
        ? `${state.bet.toLocaleString()} ×2`
        : `${state.bet.toLocaleString()}`);

  return `
    <div style="display:flex;width:1080px;height:860px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 40px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${accent};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:30px;color:${PALETTE.card};letter-spacing:-2px;">21</div>
            <div style="display:flex;margin-left:18px;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${PALETTE.ink};letter-spacing:6px;padding-right:6px;">BLACKJACK</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 16px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${PALETTE.card};letter-spacing:3px;padding-right:19px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;align-items:center;margin-top:18px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">莊家</div>
          <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;">${dealerVisibleTotal}</div>
          ${dealerBadge}
        </div>
        <div style="display:flex;width:100%;justify-content:center;margin-top:6px;">${dealerCards}</div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        ${playerSection}

        ${resultBlock}

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:20px;border-top:2px dashed ${PALETTE.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${stakeLabel}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BALANCE</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;">${(balance ?? 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:5px;color:${PALETTE.ink};padding-right:5px;">${handle}</div>
        </div>

      </div>
    </div>
  `;
}

async function generateBlackjackCard(data) {
  const markup = buildMarkup(data);
  return renderCardToPng({ markup, width: 1080, height: 860 });
}

module.exports = generateBlackjackCard;
