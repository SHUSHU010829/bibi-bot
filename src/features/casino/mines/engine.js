// 踩地雷（Mines）核心引擎：純函數，不接觸 DB / Discord。
//
// 規則：
//   - 一塊 N 格的盤面（預設 5×4 = 20 格），其中 M 格藏地雷（玩家自選 M）。
//   - 玩家逐格翻：翻到安全格（💎）→ 倍率累積、可繼續翻或收手；翻到地雷（💣）→ 整局失敗。
//   - 收手（Cash Out）→ 帶走 bet × 當前倍率（含本金）。
//   - 至少翻過 1 格才能收手（避免無風險套利）。
//   - 翻完所有安全格 → 強制結算為 win（封頂大獎）。
//
// 倍率（翻開 k 個安全格後）：
//   公平倍率 = Π_{i=0}^{k-1} (N-i)/(N-M-i)   ← 連續 k 次都避開地雷的機率倒數
//   顯示倍率 = floor2( 公平倍率 × (1 - houseEdge) )
//
// Provably-fair 風格：開局時就把地雷位置抽好存進 state.mineSet，
// 玩家每格選擇都是對既定佈局的揭曉。

const DEFAULT_HOUSE_EDGE = 0.02;
const DEFAULT_COLS = 5;
const DEFAULT_ROWS = 4;
const DEFAULT_MINES = 3;

function round2(n) {
  return Math.round(n * 100) / 100;
}
function floor2(n) {
  return Math.floor(n * 100) / 100;
}

// 在 [0, N) 中隨機挑 M 個不重複位置當地雷。
function pickMines(n, m, rng = Math.random) {
  const pool = [];
  for (let i = 0; i < n; i += 1) pool.push(i);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, m).sort((a, b) => a - b);
}

// 翻開 k 個安全格後的累積倍率。
function calcMultiplier(n, m, k, houseEdge = DEFAULT_HOUSE_EDGE) {
  if (k <= 0) return 1;
  const edge = Math.max(0, Math.min(0.5, houseEdge));
  let mult = 1;
  for (let i = 0; i < k; i += 1) {
    mult *= (n - i) / (n - m - i);
  }
  return floor2(mult * (1 - edge));
}

function startGame({
  bet,
  mines = DEFAULT_MINES,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  houseEdge = DEFAULT_HOUSE_EDGE,
  rng = Math.random,
}) {
  const n = cols * rows;
  const m = Math.max(1, Math.min(n - 1, mines));
  return {
    bet,
    status: "playing",
    cols,
    rows,
    n,
    mines: m,
    mineSet: pickMines(n, m, rng),
    revealed: [],
    hitTile: null,
    multiplier: 1,
    houseEdge,
    result: null,
    payout: 0,
  };
}

function isMine(state, tile) {
  return state.mineSet.includes(tile);
}

// 玩家翻一格。
function reveal(state, tile) {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(tile) || tile < 0 || tile >= state.n) return state;
  if (state.revealed.includes(tile)) return state;

  if (isMine(state, tile)) {
    return finalize({ ...state, hitTile: tile }, "lose", 0);
  }

  const revealed = [...state.revealed, tile];
  const multiplier = calcMultiplier(
    state.n,
    state.mines,
    revealed.length,
    state.houseEdge
  );
  const next = { ...state, revealed, multiplier };

  // 翻完所有安全格 → 封頂大獎
  if (revealed.length >= state.n - state.mines) {
    return finalize(next, "win", floorPayout(state.bet, multiplier));
  }
  return next;
}

// 玩家收手。
function cashOut(state) {
  if (state.status !== "playing") return state;
  if (state.revealed.length <= 0) return state;
  return finalize(state, "cashout", floorPayout(state.bet, state.multiplier));
}

function floorPayout(bet, multiplier) {
  return Math.floor(bet * multiplier + 1e-9);
}

function finalize(state, result, payout) {
  return { ...state, status: "settled", result, payout };
}

// 下一格翻對時的倍率（給按鈕預覽用）。
function nextMultiplier(state) {
  return calcMultiplier(
    state.n,
    state.mines,
    state.revealed.length + 1,
    state.houseEdge
  );
}

module.exports = {
  startGame,
  reveal,
  cashOut,
  isMine,
  calcMultiplier,
  nextMultiplier,
  round2,
  floor2,
  DEFAULT_HOUSE_EDGE,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_MINES,
};
