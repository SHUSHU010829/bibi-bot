// 百家樂（Baccarat）桌面圖卡：閒（PLAYER）/ 莊（BANKER）兩手牌 + 點數 + 結果橫幅。
// satori 風格沿用 generatePokerCard 的撲克牌繪製原語（SUIT_PATHS / renderCard）。
// baccarat 的牌是 { rank: 1-13, suit: "♠♥♦♣" }，與 poker 的 "AS" 字串不同，
// 這裡把 suit unicode 轉成 S/H/D/C、rank 數字轉成牌面字，再走相同的繪製流程。

const { renderCard: renderCardToPng } = require("./cardRenderer");

const PALETTE = {
  card: "#F4ECD8",
  ink: "#2A2420",
  muted: "#A89270",
  cardWhite: "#FBF7EC",
  red: "#C9302C",
  teal: "#3D6F6A",
  gold: "#D4A437",
  empty: "#D9CFB6",
};

const RANK_LABEL = {
  1: "A", 11: "J", 12: "Q", 13: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
};

const SUIT_KEY = { "♠": "S", "♥": "H", "♦": "D", "♣": "C" };

const SUIT_PATHS = {
  S: "M50 5 C32 28 8 42 8 58 C8 72 20 80 32 80 C40 80 46 75 49 68 L42 95 L58 95 L51 68 C54 75 60 80 68 80 C80 80 92 72 92 58 C92 42 68 28 50 5 Z",
  H: "M50 90 C20 65 5 50 5 30 C5 16 16 5 30 5 C40 5 47 11 50 18 C53 11 60 5 70 5 C84 5 95 16 95 30 C95 50 80 65 50 90 Z",
  D: "M50 5 L92 50 L50 95 L8 50 Z",
  C: "M50 5 C40 5 32 13 32 23 C32 28 34 32 37 35 C26 33 8 38 8 52 C8 64 20 72 34 72 C42 72 48 68 50 62 C52 68 58 72 66 72 C80 72 92 64 92 52 C92 38 74 33 63 35 C66 32 68 28 68 23 C68 13 60 5 50 5 Z M40 92 L60 92 L55 72 L45 72 Z",
};

function isRedSuit(suitKey) {
  return suitKey === "H" || suitKey === "D";
}

function renderSuitSvg(suitKey, size, color) {
  const p = SUIT_PATHS[suitKey];
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="${p}" fill="${color}"/></svg>`;
}

function renderCard(card) {
  const w = 110;
  const h = 158;
  if (!card) {
    return `<div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.empty};border:2px dashed ${PALETTE.muted};box-sizing:border-box;margin:0 8px;"></div>`;
  }
  const suitKey = SUIT_KEY[card.suit] || "S";
  const label = RANK_LABEL[card.rank] || String(card.rank);
  const color = isRedSuit(suitKey) ? PALETTE.red : PALETTE.ink;
  const suitSvg = renderSuitSvg(suitKey, 52, color);
  const rankSize = label.length > 1 ? 48 : 58;
  return `
    <div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.cardWhite};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 8px;flex-direction:column;justify-content:center;align-items:center;padding:10px 0;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:${rankSize}px;color:${color};line-height:1;letter-spacing:-2px;">${label}</div>
      <div style="display:flex;margin-top:12px;">${suitSvg}</div>
    </div>
  `;
}

function buildHand(label, side, cards, total, isWinner, pairHit, pairLabel) {
  const accent = isWinner ? PALETTE.gold : PALETTE.teal;
  const cardsHtml = cards.map((c) => renderCard(c)).join("");
  const pairBadge = pairHit
    ? `<div style="display:flex;margin-left:14px;padding:4px 14px;background:${PALETTE.red};font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${PALETTE.card};letter-spacing:2px;line-height:1.3;padding-right:16px;">${pairLabel}</div>`
    : "";
  return `
    <div style="display:flex;flex-direction:column;align-items:center;width:48%;">
      <div style="display:flex;align-items:center;justify-content:center;width:100%;">
        <div style="display:flex;width:48px;height:48px;background:${accent};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:28px;color:${PALETTE.card};">${label}</div>
        <div style="display:flex;margin-left:14px;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${PALETTE.ink};letter-spacing:4px;padding-right:4px;">${side}</div>
        ${pairBadge}
      </div>
      <div style="display:flex;justify-content:center;align-items:center;width:100%;margin-top:22px;min-height:158px;">${cardsHtml}</div>
      <div style="display:flex;align-items:flex-end;margin-top:24px;">
        <div style="display:flex;font-family:'SpaceMono';font-size:15px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">POINTS</div>
        <div style="display:flex;margin-left:10px;font-family:'NotoSansTC';font-weight:900;font-size:64px;color:${accent};line-height:1;">${total}</div>
      </div>
    </div>
  `;
}

function buildMarkup(data) {
  const {
    player,
    banker,
    playerTotal,
    bankerTotal,
    outcome,
    playerPair,
    bankerPair,
    betLabel,
    betAmount,
    payout,
    net,
    balance,
    username,
  } = data;

  const playerWin = outcome === "player";
  const bankerWin = outcome === "banker";

  // ASCII 標點：NotoSansTC 子集沒有 ！，會變成 tofu。
  let bannerText;
  let bannerColor;
  if (bankerWin) {
    bannerText = "莊贏  BANKER WINS";
    bannerColor = PALETTE.gold;
  } else if (playerWin) {
    bannerText = "閒贏  PLAYER WINS";
    bannerColor = PALETTE.teal;
  } else {
    bannerText = "和  TIE";
    bannerColor = PALETTE.muted;
  }

  const won = payout > 0;
  const resultLine = won
    ? `中獎  +${payout.toLocaleString()} CREDITS`
    : net === 0
    ? `和局退回本金`
    : `沒中  下次再來`;
  const resultColor = won ? PALETTE.gold : PALETTE.muted;

  const playerHand = buildHand(
    "閒",
    "PLAYER",
    player,
    playerTotal,
    playerWin,
    playerPair,
    "閒對"
  );
  const bankerHand = buildHand(
    "莊",
    "BANKER",
    banker,
    bankerTotal,
    bankerWin,
    bankerPair,
    "莊對"
  );

  return `
    <div style="display:flex;width:1080px;height:760px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:30px 44px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:64px;height:64px;background:${PALETTE.ink};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.card};">樂</div>
            <div style="display:flex;margin-left:20px;font-family:'NotoSansTC';font-weight:900;font-size:40px;color:${PALETTE.ink};letter-spacing:5px;padding-right:5px;">BACCARAT</div>
            <div style="display:flex;margin-left:16px;font-family:'NotoSansTC';font-weight:500;font-size:24px;color:${PALETTE.muted};letter-spacing:3px;padding-right:3px;">百家樂</div>
          </div>
          <div style="display:flex;align-items:center;padding:8px 18px;background:${bannerColor};font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.card};letter-spacing:3px;padding-right:21px;">${bannerText}</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:18px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;margin-top:28px;">
          ${playerHand}
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;align-self:center;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:40px;color:${PALETTE.muted};letter-spacing:2px;line-height:1;">VS</div>
          </div>
          ${bankerHand}
        </div>

        <div style="display:flex;flex:1;justify-content:center;align-items:center;width:100%;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${resultColor};letter-spacing:5px;line-height:1;padding-right:5px;">${resultLine}</div>
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:14px;border-top:2px dashed ${PALETTE.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;padding-right:5px;">${(betAmount || 0).toLocaleString()}</div>
            <div style="display:flex;margin-left:14px;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.teal};line-height:1;padding-right:4px;">${betLabel || ""}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">BALANCE</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;">${(balance || 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${PALETTE.muted};padding-right:4px;">逼逼賭場 · BACCARAT</div>
        </div>

      </div>
    </div>
  `;
}

async function generateBaccaratCard(data) {
  const markup = buildMarkup(data);
  return renderCardToPng({ markup, width: 1080, height: 760 });
}

module.exports = generateBaccaratCard;
module.exports.buildMarkup = buildMarkup;
