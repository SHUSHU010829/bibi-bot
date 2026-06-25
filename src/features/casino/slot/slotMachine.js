const {
  SYMBOLS,
  TOTAL_WEIGHT,
  TRIPLE_PAYOUTS,
  JACKPOT_SYMBOL,
  TWO_MATCH_MULTIPLIER,
  TWO_CHERRY_BONUS,
  PAYLINES,
} = require("./paytable");

const ROWS = 3;
const COLS = 3;

function pickSymbol() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const sym of SYMBOLS) {
    roll -= sym.weight;
    if (roll < 0) return sym;
  }
  return SYMBOLS[SYMBOLS.length - 1];
}

function spinGrid() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) row.push(pickSymbol());
    grid.push(row);
  }
  return grid;
}

function evaluateLine(symbols) {
  const [a, b, c] = symbols;
  const allSame = a.id === b.id && b.id === c.id;

  if (allSame) {
    const mult = TRIPLE_PAYOUTS[a.id] ?? 0;
    return {
      matchType: a.id === JACKPOT_SYMBOL ? "jackpot" : "triple",
      multiplier: mult,
      matchedSymbol: a.id,
    };
  }

  let matchedSymbol = null;
  if (a.id === b.id || a.id === c.id) matchedSymbol = a.id;
  else if (b.id === c.id) matchedSymbol = b.id;

  if (matchedSymbol) {
    let multiplier = TWO_MATCH_MULTIPLIER;
    let matchType = "double";
    if (matchedSymbol === "cherry") {
      multiplier += TWO_CHERRY_BONUS;
      matchType = "double_cherry";
    }
    return { matchType, multiplier, matchedSymbol };
  }

  return { matchType: "none", multiplier: 0, matchedSymbol: null };
}

const TIER = { none: 0, double: 1, double_cherry: 2, triple: 3, jackpot: 4 };

/**
 * 跑一次 3x3 抽獎。
 * 下注金額會平均分到 5 條 payline（每線 bet = floor(bet/5)，至少 1）。
 *
 * @param {{ bet: number }} opts
 * @returns {{
 *   grid: Array<Array<{id:string, emoji:string}>>,
 *   lines: Array<{
 *     index:number, id:string, name:string,
 *     cells:Array<[number,number]>,
 *     cellSymbols:Array<{id:string, emoji:string}>,
 *     matchType:string, multiplier:number, payout:number, matchedSymbol:string|null,
 *   }>,
 *   matchType: "jackpot"|"triple"|"double_cherry"|"double"|"none",
 *   multiplier: number,
 *   payout: number,
 *   matchKey: string,
 *   matchedSymbol: string|null,
 *   perLineBet: number,
 *   winLineCount: number,
 *   jackpotLineCount: number,
 * }}
 */
function spin({ bet }) {
  const grid = spinGrid();
  const lineCount = PAYLINES.length;
  const perLineBet = Math.max(1, Math.floor(bet / lineCount));

  const lines = PAYLINES.map((pl, idx) => {
    const cellSymbols = pl.cells.map(([r, c]) => grid[r][c]);
    const ev = evaluateLine(cellSymbols);
    return {
      index: idx,
      id: pl.id,
      name: pl.name,
      cells: pl.cells,
      cellSymbols: cellSymbols.map((s) => ({ id: s.id, emoji: s.emoji })),
      matchType: ev.matchType,
      multiplier: ev.multiplier,
      matchedSymbol: ev.matchedSymbol,
      payout: ev.multiplier > 0 ? Math.floor(perLineBet * ev.multiplier) : 0,
    };
  });

  const totalPayout = lines.reduce((s, l) => s + l.payout, 0);
  const winLines = lines.filter((l) => l.payout > 0);
  const jackpotLines = lines.filter((l) => l.matchType === "jackpot");

  const bestLine = lines.reduce(
    (best, cur) => (TIER[cur.matchType] > TIER[best?.matchType ?? "none"] ? cur : best),
    null
  );

  const matchType = bestLine?.matchType ?? "none";
  const matchKey =
    winLines.length === 0
      ? "none"
      : winLines.map((l) => `${l.id}:${l.matchType}`).join(",");
  const aggregatedMultiplier =
    bet > 0 ? Math.round((totalPayout / bet) * 100) / 100 : 0;

  return {
    grid: grid.map((row) => row.map((s) => ({ id: s.id, emoji: s.emoji }))),
    lines,
    matchType,
    multiplier: aggregatedMultiplier,
    payout: totalPayout,
    matchKey,
    matchedSymbol: bestLine?.matchedSymbol ?? null,
    perLineBet,
    winLineCount: winLines.length,
    jackpotLineCount: jackpotLines.length,
  };
}

module.exports = { spin, evaluateLine, spinGrid, pickSymbol, ROWS, COLS };
