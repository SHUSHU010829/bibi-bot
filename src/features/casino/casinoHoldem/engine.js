// Casino Hold'em（單人對莊家德州撲克）核心邏輯。
// 重用德州撲克的 7 取 5 評估器（poker/hand.js）與牌堆（poker/deck.js）。
//
// 規則：
//  1. 玩家下底注（ante），發 2 張底牌給玩家、2 張給莊家（暗）、翻 3 張公共牌（flop）。
//  2. 玩家選擇 跟注（call bet = 2×ante）或 蓋牌（棄底注）。
//  3. 跟注後補 turn + river（共 5 張公共牌），雙方用 2 底牌 + 5 公共牌取最佳 5 張。
//  4. 莊家以「一對 4」以上才合格（qualify）。
//     - 莊家不合格：底注依賠率表賠付、跟注退回（push）。
//     - 莊家合格且玩家贏：底注依賠率表賠付，跟注 1:1。
//     - 莊家合格且平手：底注、跟注皆退回。
//     - 莊家合格且玩家輸：底注、跟注皆輸。
//
// 賠率表（底注獲勝時的「淨贏倍數」）：
//   皇家同花順 100:1、同花順 20:1、四條 10:1、葫蘆 3:1、同花 2:1、順子(含)以下 1:1。

const { freshShuffledDeck } = require("../poker/deck");
const { evaluate7, compareScores } = require("../poker/hand");

// 莊家合格門檻：一對 4（category 2、pairRank >= 4）以上。
// score 結構 [category, ...]，一對的 pairRank 在 score[1]。
const DEALER_QUALIFY_SCORE = [2, 4, 0, 0, 0];

// 底注賠率（淨贏倍數）。key 為 poker/hand.js 的 category（皇家同花順額外判斷）。
function anteOddsMultiplier(score) {
  const category = score[0];
  if (category === 9) {
    // 同花順；topRank 14 = 皇家同花順
    return score[1] === 14 ? 100 : 20;
  }
  if (category === 8) return 10; // 四條
  if (category === 7) return 3; // 葫蘆
  if (category === 6) return 2; // 同花
  return 1; // 順子（5）及以下
}

function dealerQualifies(dealerScore) {
  return compareScores(dealerScore, DEALER_QUALIFY_SCORE) >= 0;
}

// 開局：發牌、翻 flop。community 一次發滿 5 張，flop 階段只揭露前 3。
function startGame({ ante }) {
  const deck = freshShuffledDeck();
  const player = [deck.shift(), deck.shift()];
  const dealer = [deck.shift(), deck.shift()];
  const community = [
    deck.shift(),
    deck.shift(),
    deck.shift(),
    deck.shift(),
    deck.shift(),
  ];
  return {
    ante,
    deck,
    player,
    dealer,
    community,
    stage: "flop",
    status: "playing",
  };
}

// 蓋牌：棄底注，無賠付。
function resolveFold(state) {
  return {
    ...state,
    stage: "river",
    status: "settled",
    folded: true,
    dealerQualified: null,
    result: "fold",
    // 派彩（含本金）為 0，淨輸 = ante。
    payout: 0,
    callBet: 0,
  };
}

// 跟注並結算。callBet = 2×ante 已在外層扣款。
// payout 為「應發還給玩家的金額」（含退回的本金）：
//   net = payout - (ante + callBet)
function resolveCall(state) {
  const ante = state.ante;
  const callBet = ante * 2;
  const playerScore = evaluate7([...state.player, ...state.community]);
  const dealerScore = evaluate7([...state.dealer, ...state.community]);
  const qualified = dealerQualifies(dealerScore);
  const cmp = compareScores(playerScore, dealerScore); // >0 玩家勝

  let result;
  let payout = 0;
  const anteMult = anteOddsMultiplier(playerScore);

  if (!qualified) {
    // 莊家不合格：底注依賠率表賠（贏 ante×mult），跟注退回。
    result = "dealer_no_qualify";
    payout = ante + ante * anteMult + callBet;
  } else if (cmp > 0) {
    // 莊家合格、玩家贏：底注賠率表 + 跟注 1:1。
    result = "win";
    payout = ante + ante * anteMult + callBet * 2;
  } else if (cmp === 0) {
    // 平手：底注、跟注皆退回。
    result = "push";
    payout = ante + callBet;
  } else {
    // 玩家輸：兩注皆輸。
    result = "lose";
    payout = 0;
  }

  return {
    ...state,
    stage: "river",
    status: "settled",
    folded: false,
    callBet,
    dealerQualified: qualified,
    playerScore,
    dealerScore,
    result,
    payout,
  };
}

module.exports = {
  startGame,
  resolveFold,
  resolveCall,
  anteOddsMultiplier,
  dealerQualifies,
  DEALER_QUALIFY_SCORE,
};
