// src/features/casino/roulette/engine.js

const { BET_TYPES } = require('./numbers');

/** 隨機抽出結果號碼（0–36 等機率） */
function spinWheel() {
  return Math.floor(Math.random() * 37);
}

/**
 * 結算所有押注。
 * bets: [{ type, amount, numbers }]
 * result: 0–36
 *
 * 回傳 {
 *   result,
 *   betResults: [{ type, amount, numbers, payout, won, winAmount }],
 *   totalWin,    // 派彩利潤（不含本金）
 *   totalPayout  // 實際拿回金額（含本金，只計算獲勝的注）
 * }
 */
function settle(bets, result) {
  let totalWin = 0;
  let totalPayout = 0;

  const betResults = bets.map(bet => {
    const def = BET_TYPES[bet.type];
    if (!def) return { ...bet, payout: 0, won: false, winAmount: 0 };

    const won = bet.numbers.includes(result);
    const winAmount = won ? bet.amount * def.payout : 0;

    if (won) {
      totalWin += winAmount;
      totalPayout += bet.amount + winAmount;
    }

    return { ...bet, payout: def.payout, won, winAmount };
  });

  return { result, betResults, totalWin, totalPayout };
}

/** 計算所有押注的總下注額 */
function totalWagered(bets) {
  return bets.reduce((s, b) => s + b.amount, 0);
}

module.exports = { spinWheel, settle, totalWagered };
