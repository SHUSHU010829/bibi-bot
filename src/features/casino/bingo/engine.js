// 賓果 Bingo 核心邏輯（純函式，無 DB / 無 Discord 依賴）。
// 5×5 卡片，數字 1..75 依經典分欄（B:1-15 / I:16-30 / N:31-45 / G:46-60 / O:61-75），
// 正中央為 FREE（自動標記）。開出固定球數後計算連線數，連線數對應賠率倍率（含本金）。
const crypto = require("crypto");

const SIZE = 5;
const CENTER = 2;

// 五欄的數字範圍（B I N G O）
const COLUMN_RANGES = [
  [1, 15],
  [16, 30],
  [31, 45],
  [46, 60],
  [61, 75],
];

// 預設開球數：經 Monte-Carlo 模擬使 RTP 落在 0.90~0.94。
const DEFAULT_BALLS_DRAWN = 30;

// 賠率表（含本金），index = 完成的連線數（0..12）。
// 0 線 = 輸。經 500k 模擬，整體 RTP ≈ 0.92。
const DEFAULT_LINE_PAYTABLE = [
  0, 5, 16, 85, 500, 3000, 10000, 20000, 30000, 40000, 50000, 75000, 100000,
];

function sampleWithoutReplacement(pool, n) {
  const arr = pool.slice();
  const out = [];
  for (let i = 0; i < n && arr.length > 0; i++) {
    const r = crypto.randomInt(arr.length);
    out.push(arr[r]);
    arr.splice(r, 1);
  }
  return out;
}

function rangeArray(lo, hi) {
  const arr = [];
  for (let v = lo; v <= hi; v++) arr.push(v);
  return arr;
}

// 產生 5×5 卡片，card[row][col]，正中央為 0（代表 FREE）。
function buildCard() {
  const columns = COLUMN_RANGES.map(([lo, hi]) =>
    sampleWithoutReplacement(rangeArray(lo, hi), SIZE)
  );
  const card = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      row.push(r === CENTER && c === CENTER ? 0 : columns[c][r]);
    }
    card.push(row);
  }
  return card;
}

// 依抽出的球計算標記矩陣（FREE 與被抽中的格子為 true）。
function buildMarks(card, drawnSet) {
  const marks = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      if (r === CENTER && c === CENTER) row.push(true);
      else row.push(drawnSet.has(card[r][c]));
    }
    marks.push(row);
  }
  return marks;
}

// 計算完成的連線數：5 列 + 5 行 + 2 對角線 = 最多 12 條。
function countLines(marks) {
  let lines = 0;
  for (let r = 0; r < SIZE; r++) {
    if (marks[r].every(Boolean)) lines++;
  }
  for (let c = 0; c < SIZE; c++) {
    let all = true;
    for (let r = 0; r < SIZE; r++) {
      if (!marks[r][c]) {
        all = false;
        break;
      }
    }
    if (all) lines++;
  }
  let diag1 = true;
  let diag2 = true;
  for (let i = 0; i < SIZE; i++) {
    if (!marks[i][i]) diag1 = false;
    if (!marks[i][SIZE - 1 - i]) diag2 = false;
  }
  if (diag1) lines++;
  if (diag2) lines++;
  return lines;
}

function resolvePaytable(paytable) {
  if (Array.isArray(paytable) && paytable.length >= 13) return paytable.slice();
  return DEFAULT_LINE_PAYTABLE.slice();
}

// 開一局並立即結算。回傳卡片、標記、抽球、連線數、倍率與賠付。
function playRound({ bet, ballsDrawn, linePaytable } = {}) {
  const balls =
    Number.isInteger(ballsDrawn) && ballsDrawn > 0 && ballsDrawn <= 75
      ? ballsDrawn
      : DEFAULT_BALLS_DRAWN;
  const paytable = resolvePaytable(linePaytable);

  const card = buildCard();
  const drawn = sampleWithoutReplacement(rangeArray(1, 75), balls);
  const drawnSet = new Set(drawn);
  const marks = buildMarks(card, drawnSet);
  const linesCompleted = countLines(marks);

  const multiplier = paytable[linesCompleted] ?? 0;
  const payout = multiplier > 0 ? Math.floor(bet * multiplier) : 0;

  return {
    bet,
    ballsDrawn: balls,
    card,
    marks,
    drawn,
    linesCompleted,
    multiplier,
    payout,
    result: payout > 0 ? "win" : "loss",
  };
}

module.exports = {
  SIZE,
  CENTER,
  COLUMN_RANGES,
  DEFAULT_BALLS_DRAWN,
  DEFAULT_LINE_PAYTABLE,
  buildCard,
  buildMarks,
  countLines,
  playRound,
};
