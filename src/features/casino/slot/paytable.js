// 拉霸（吃角子老虎）賠率表。
// 6 種符號（含 JACKPOT）+ 三連線/兩連線賠率。
// 設計目標 RTP ≈ 82-86%（控通膨後）。

const SYMBOLS = [
  { id: "cherry", emoji: "🍒", weight: 35 },
  { id: "lemon", emoji: "🍋", weight: 25 },
  { id: "watermelon", emoji: "🍉", weight: 18 },
  { id: "bell", emoji: "🔔", weight: 12 },
  { id: "star", emoji: "⭐", weight: 7 },
  { id: "seven", emoji: "7️⃣", weight: 3 },
];

// 三連線倍率（純獎金倍率，不含本金）
const TRIPLE_PAYOUTS = {
  cherry: 2,
  lemon: 5,
  watermelon: 14,
  bell: 28,
  star: 75,
  seven: 450, // JACKPOT
};

const JACKPOT_SYMBOL = "seven";

// 兩連線（任兩格相同，第三格不同）基礎倍率
const TWO_MATCH_MULTIPLIER = 0.5;

// 兩個 cherry 的額外加成（總倍率 = 0.5 + 1.0 = 1.5）
const TWO_CHERRY_BONUS = 1.0;

const TOTAL_WEIGHT = SYMBOLS.reduce((s, x) => s + x.weight, 0);
const SYMBOL_BY_ID = Object.fromEntries(SYMBOLS.map((s) => [s.id, s]));

function getSymbolById(id) {
  return SYMBOL_BY_ID[id] || null;
}

module.exports = {
  SYMBOLS,
  SYMBOL_BY_ID,
  TOTAL_WEIGHT,
  TRIPLE_PAYOUTS,
  JACKPOT_SYMBOL,
  TWO_MATCH_MULTIPLIER,
  TWO_CHERRY_BONUS,
  getSymbolById,
};
