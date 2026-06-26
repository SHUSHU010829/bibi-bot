// 魚蝦蟹（Fish-Prawn-Crab / Hoo Hey How）純結算引擎。
// 三顆骰子，每面是六種符號之一。玩家押其中一種符號，
// 依三顆骰中該符號出現次數派彩：
//   0 → 沒中；1 → 1:1（拿回 2 倍）；2 → 2:1（拿回 3 倍）；3 → 3:1（拿回 4 倍）。
// 與骰寶的「單骰」同樣的數學。

// 六種符號（key 為系統內部代號，name 為玩家可見中文，emoji 搭配顯示）
const SYMBOLS = [
  { key: "fish", name: "魚", emoji: "🐟" },
  { key: "prawn", name: "蝦", emoji: "🦐" },
  { key: "crab", name: "蟹", emoji: "🦀" },
  { key: "gourd", name: "葫蘆", emoji: "🫛" },
  { key: "coin", name: "金錢", emoji: "🪙" },
  { key: "rooster", name: "雞", emoji: "🐓" },
];

const SYMBOL_BY_KEY = SYMBOLS.reduce((m, s) => {
  m[s.key] = s;
  return m;
}, {});

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 擲三顆骰，回傳三個符號 key 陣列。
function rollThree() {
  return [0, 0, 0].map(() => SYMBOLS[randInt(0, SYMBOLS.length - 1)].key);
}

function symbolLabel(key) {
  const s = SYMBOL_BY_KEY[key];
  return s ? `${s.emoji} ${s.name}` : key;
}

// 結算單一注。bet = { symbol, amount }
// 回傳 { won, payout, multiplier, count }
//   payout 是拿回的總額（含本金），輸 = 0
//   multiplier 是純獎金倍率（= count），輸時為 0
function settleBet(bet, roll) {
  const count = roll.filter((r) => r === bet.symbol).length;
  if (count === 0) return { won: false, payout: 0, multiplier: 0, count: 0 };
  return {
    won: true,
    payout: bet.amount * (1 + count),
    multiplier: count,
    count,
  };
}

function settleRound(bets, roll) {
  const results = bets.map((bet) => ({
    bet,
    ...settleBet(bet, roll),
  }));
  const totalBet = bets.reduce((s, b) => s + b.amount, 0);
  const totalPayout = results.reduce((s, r) => s + r.payout, 0);
  return { roll, totalBet, totalPayout, results };
}

module.exports = {
  SYMBOLS,
  SYMBOL_BY_KEY,
  rollThree,
  symbolLabel,
  settleBet,
  settleRound,
};
