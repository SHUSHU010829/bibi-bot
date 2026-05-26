// 尋寶（簡易版 Keno）核心邏輯。
// 地圖 20 格（4×5），玩家挑 5 格，系統開出 5 格寶藏。
// 命中數 → 賠率（含本金）。
const crypto = require("crypto");

const BOARD_SIZE = 20;
const PICK_COUNT = 5;
const TREASURE_COUNT = 5;

// 賠率表（multiplier 含本金）：index = 命中數
const DEFAULT_PAYTABLE = [0, 0, 2, 4, 20, 400];

function sampleWithoutReplacement(pool, n) {
  const arr = pool.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = crypto.randomInt(arr.length);
    out.push(arr[r]);
    arr.splice(r, 1);
  }
  return out;
}

function range1To(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

function newGame({ bet, paytable }) {
  const treasures = sampleWithoutReplacement(range1To(BOARD_SIZE), TREASURE_COUNT);
  return {
    bet,
    boardSize: BOARD_SIZE,
    pickCount: PICK_COUNT,
    treasureCount: TREASURE_COUNT,
    treasures,
    picks: [],
    paytable: (paytable && paytable.length === PICK_COUNT + 1) ? paytable.slice() : DEFAULT_PAYTABLE.slice(),
    status: "selecting", // selecting | settled | cancelled
    hitCount: 0,
    multiplier: 0,
    payout: 0,
    result: null, // win | loss | cancelled
  };
}

function togglePick(state, tile) {
  if (state.status !== "selecting") return state;
  if (!Number.isInteger(tile) || tile < 1 || tile > state.boardSize) return state;
  const idx = state.picks.indexOf(tile);
  if (idx >= 0) {
    const picks = state.picks.slice();
    picks.splice(idx, 1);
    return { ...state, picks };
  }
  if (state.picks.length >= state.pickCount) return state;
  return { ...state, picks: [...state.picks, tile] };
}

function quickPick(state) {
  if (state.status !== "selecting") return state;
  const picks = sampleWithoutReplacement(range1To(state.boardSize), state.pickCount);
  return { ...state, picks };
}

function clearPicks(state) {
  if (state.status !== "selecting") return state;
  return { ...state, picks: [] };
}

function reveal(state) {
  if (state.status !== "selecting") return state;
  if (state.picks.length !== state.pickCount) return state;
  const treasureSet = new Set(state.treasures);
  const hitCount = state.picks.reduce((acc, p) => acc + (treasureSet.has(p) ? 1 : 0), 0);
  const multiplier = state.paytable[hitCount] ?? 0;
  const payout = multiplier > 0 ? Math.floor(state.bet * multiplier) : 0;
  return {
    ...state,
    status: "settled",
    hitCount,
    multiplier,
    payout,
    result: payout > 0 ? "win" : "loss",
  };
}

function cancel(state) {
  if (state.status !== "selecting") return state;
  return { ...state, status: "cancelled", result: "cancelled", payout: 0 };
}

module.exports = {
  BOARD_SIZE,
  PICK_COUNT,
  TREASURE_COUNT,
  DEFAULT_PAYTABLE,
  newGame,
  togglePick,
  quickPick,
  clearPicks,
  reveal,
  cancel,
};
