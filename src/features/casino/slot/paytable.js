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

// 3x3 角子老虎連線：3 橫排 + 2 對角線，共 5 條 payline。
// cells: [row, col]，row 0 為上、col 0 為左。
const PAYLINES = [
  { id: "row_top", name: "上排", cells: [[0, 0], [0, 1], [0, 2]] },
  { id: "row_mid", name: "中排", cells: [[1, 0], [1, 1], [1, 2]] },
  { id: "row_bot", name: "下排", cells: [[2, 0], [2, 1], [2, 2]] },
  { id: "diag_dn", name: "左上對角", cells: [[0, 0], [1, 1], [2, 2]] },
  { id: "diag_up", name: "左下對角", cells: [[2, 0], [1, 1], [0, 2]] },
];

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
  PAYLINES,
  getSymbolById,
};
