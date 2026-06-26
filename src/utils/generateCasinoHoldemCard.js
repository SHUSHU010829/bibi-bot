// 賭場德州撲克（單人對莊家）桌面圖卡。
// 取材自 generatePokerCard 的 satori 風格與卡牌繪製基本元件，
// 採用 heads-up 版面：莊家列 / 公共牌 / 玩家列。

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
  back: "#7A1F1C",
  backDark: "#5C1614",
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

// 牌背（暗牌）：菱格紋的紅色背面，用於莊家底牌與尚未揭露的公共牌。
function renderCardBack(opts = {}) {
  const w = opts.width || 96;
  const h = opts.height || 138;
  return `
    <div style="display:flex;width:${w}px;height:${h}px;background:${PALETTE.back};border:3px solid ${PALETTE.ink};box-sizing:border-box;margin:0 6px;flex-direction:column;justify-content:center;align-items:center;padding:8px;">
      <div style="display:flex;width:100%;height:100%;border:2px solid ${PALETTE.gold};box-sizing:border-box;align-items:center;justify-content:center;background:${PALETTE.backDark};">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${PALETTE.gold};letter-spacing:-1px;">逼</div>
      </div>
    </div>
  `;
}

const RESULT_BANNER = {
  win: { text: "你贏了！", color: PALETTE.teal },
  lose: { text: "莊家贏了", color: PALETTE.red },
  push: { text: "平手 · 退回本金", color: PALETTE.neutral },
  dealer_no_qualify: { text: "莊家不合格 · 照賠", color: PALETTE.gold },
  fold: { text: "你蓋牌了", color: PALETTE.neutral },
};

function infoChip(label, value, valueColor) {
  return `
    <div style="display:flex;align-items:flex-end;margin:0 24px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${PALETTE.muted};line-height:1;padding-right:4px;">${label}</div>
      <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${valueColor || PALETTE.ink};line-height:1;">${value}</div>
    </div>
  `;
}

function handLabelTag(score, won) {
  if (!score) return "";
  const color = won ? PALETTE.gold : PALETTE.neutral;
  return `<div style="display:flex;margin-left:14px;padding:4px 12px;background:${color};color:${PALETTE.cardWhite};font-family:'NotoSansTC';font-weight:900;font-size:16px;letter-spacing:1px;line-height:1.4;">${categoryLabel(score)}</div>`;
}

function rowLabel(zh, en, color) {
  return `
    <div style="display:flex;align-items:center;width:170px;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${color};letter-spacing:2px;padding-right:3px;">${zh}</div>
      <div style="display:flex;margin-left:8px;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${PALETTE.muted};">${en}</div>
    </div>
  `;
}

function buildMarkup(state, { username } = {}) {
  const isSettled = state.status === "settled";
  const folded = isSettled && state.folded;
  const revealed = isSettled && !folded; // 跟注結算：全揭露

  const player = state.player || [];
  const dealer = state.dealer || [];
  const community = state.community || [];

  // 莊家列：揭露時顯示底牌，否則牌背。
  let dealerCards;
  if (revealed) {
    dealerCards = [dealer[0], dealer[1]].map((c) => renderCard(c)).join("");
  } else {
    dealerCards = `${renderCardBack()}${renderCardBack()}`;
  }

  // 公共牌列：flop 進行中 / 蓋牌 → 前 3 張揭露、後 2 張暗牌（牌背）。
  //            跟注結算 → 全 5 張揭露。
  const communityCards = [0, 1, 2, 3, 4]
    .map((i) => {
      if (revealed) return renderCard(community[i] || null);
      if (i < 3) return renderCard(community[i] || null);
      return renderCardBack();
    })
    .join("");

  // 玩家底牌一律揭露。
  const playerCards = [player[0], player[1]].map((c) => renderCard(c)).join("");

  const playerWon = state.result === "win" || state.result === "dealer_no_qualify";
  const ante = state.ante || 0;
  const callBet = isSettled && !folded ? (state.callBet || ante * 2) : 0;
  const stake = ante + callBet;
  const pot = stake * 2;

  // 結果橫幅
  const banner = isSettled ? RESULT_BANNER[state.result] || RESULT_BANNER.lose : null;

  const playerNameColor = playerWon && revealed ? PALETTE.gold : PALETTE.ink;
  const dealerHandTag = revealed ? handLabelTag(state.dealerScore, !playerWon) : "";
  const playerHandTag = revealed ? handLabelTag(state.playerScore, playerWon) : "";

  const qualifyLine = revealed
    ? `<div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${state.dealerQualified ? PALETTE.teal : PALETTE.gold};letter-spacing:1px;padding-right:2px;">${state.dealerQualified ? "莊家合格（一對 4 以上）" : "莊家不合格 · 底注照賠、跟注退回"}</div>`
    : "";

  const bannerHtml = banner
    ? `
      <div style="display:flex;width:100%;justify-content:center;margin-top:20px;">
        <div style="display:flex;align-items:center;padding:10px 28px;background:${banner.color};">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${PALETTE.cardWhite};letter-spacing:3px;padding-right:3px;">${banner.text}</div>
        </div>
      </div>
    `
    : `
      <div style="display:flex;width:100%;justify-content:center;margin-top:20px;">
        <div style="display:flex;align-items:center;padding:8px 24px;background:${PALETTE.ink};">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.card};letter-spacing:3px;padding-right:3px;">翻牌圈 · 跟注或蓋牌？</div>
        </div>
      </div>
    `;

  // 資訊列：結算後顯示底注 / 跟注 / 派彩；進行中顯示底注 / 跟注需押。
  let infoRow;
  if (isSettled && !folded) {
    const net = (state.payout || 0) - stake;
    const netColor = net > 0 ? PALETTE.teal : net < 0 ? PALETTE.red : PALETTE.neutral;
    const netStr = `${net > 0 ? "＋" : net < 0 ? "－" : "±"}${Math.abs(net).toLocaleString()}`;
    infoRow =
      infoChip("底注", ante.toLocaleString()) +
      infoChip("跟注", callBet.toLocaleString()) +
      infoChip("淨輸贏", netStr, netColor);
  } else if (folded) {
    infoRow =
      infoChip("底注", ante.toLocaleString()) +
      infoChip("損失", `－${ante.toLocaleString()}`, PALETTE.red);
  } else {
    infoRow =
      infoChip("底注", ante.toLocaleString()) +
      infoChip("跟注需押", (ante * 2).toLocaleString(), PALETTE.teal);
  }

  return `
    <div style="display:flex;width:1080px;height:880px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:28px 44px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${PALETTE.red};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:24px;color:${PALETTE.card};letter-spacing:-1px;">CH</div>
            <div style="display:flex;flex-direction:column;margin-left:18px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${PALETTE.ink};letter-spacing:4px;padding-right:4px;">CASINO HOLD'EM</div>
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.muted};letter-spacing:6px;padding-right:6px;">德州撲克</div>
            </div>
          </div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;align-items:center;margin-top:18px;">
          ${rowLabel("莊家", "DEALER", PALETTE.ink)}
          <div style="display:flex;align-items:center;">${dealerCards}</div>
          ${dealerHandTag}
        </div>

        <div style="display:flex;width:100%;justify-content:center;align-items:center;margin-top:22px;">${communityCards}</div>

        <div style="display:flex;width:100%;align-items:center;margin-top:22px;">
          ${rowLabel("你", "PLAYER", playerNameColor)}
          <div style="display:flex;align-items:center;">${playerCards}</div>
          ${playerHandTag}
        </div>

        ${qualifyLine}

        ${bannerHtml}

        <div style="display:flex;width:100%;height:0;margin-top:20px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;justify-content:center;align-items:center;margin-top:16px;">${infoRow}</div>

        <div style="display:flex;width:100%;justify-content:flex-end;margin-top:auto;padding-top:12px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${PALETTE.muted};padding-right:4px;">逼逼賭場 · CASINO HOLD'EM</div>
        </div>

      </div>
    </div>
  `;
}

async function generateCasinoHoldemCard(state, { username, balance, net } = {}) {
  const markup = buildMarkup(state, { username, balance, net });
  return renderCardToPng({ markup, width: 1080, height: 880 });
}

module.exports = generateCasinoHoldemCard;
module.exports.generateCasinoHoldemCard = generateCasinoHoldemCard;
module.exports.buildMarkup = buildMarkup;
