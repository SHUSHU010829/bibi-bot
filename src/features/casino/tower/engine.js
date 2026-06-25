// 爬塔（Tower / Dragon Tower）核心引擎：純函數，不接觸 DB / Discord。
//
// 規則：
//   - 一座塔有 maxFloors 層，從第 1 層（底層）往上爬。
//   - 每層有 tilesPerFloor 格，其中 trapsPerFloor 格藏著陷阱（💥），其餘是安全格。
//   - 玩家每層挑一格：踩到安全格 → 倍率累積、爬升一層，可繼續爬或收手。
//   - 踩到陷阱 → 整局失敗，先前累積全沒。
//   - 收手（Cash Out）→ 帶走 bet × 累積倍率（含本金）。
//   - 至少爬過 1 層才能收手（避免無風險套利）。
//   - 爬到頂（清完最後一層）→ 強制結算為 cashout（封頂大獎）。
//
// 難度決定每層格數與陷阱數，安全機率越低、每層倍率越高：
//   easy   4 格 1 雷 → 安全 3/4
//   medium 3 格 1 雷 → 安全 2/3
//   hard   2 格 1 雷 → 安全 1/2
//   hell   3 格 2 雷 → 安全 1/3
//
// 每層倍率（固定）：
//   floorMul = floor2( (tiles / safe) × (1 - houseEdge) )
//   清完 n 層後 accMultiplier = floorMul^n
//   payout = floor(bet × accMultiplier)
//
// Provably-fair 風格：開局時就把每層的陷阱位置抽好存進 state.traps，
// 玩家每格選擇都是對既定佈局的揭曉，後端不會「事後移動陷阱」。
//
// State：
//   {
//     bet, status: "playing"|"settled",
//     difficulty, tilesPerFloor, trapsPerFloor, maxFloors,
//     traps: number[][],        // traps[floor] = 該層陷阱所在的格子 index 陣列
//     currentFloor: number,     // 0-based，下一個要挑戰的層（= 已清層數）
//     picks: number[],          // picks[floor] = 玩家在該層選的格子 index
//     hitTile: number|null,     // 失敗時踩到的格子 index
//     floorMultiplier: number,  // 每層固定倍率
//     accMultiplier: number,    // 當前累積倍率
//     houseEdge: number,
//     result: "cashout"|"lose"|"win"|null,
//     payout: number,           // 最終派彩（含本金）；輸 = 0
//   }

const DEFAULT_HOUSE_EDGE = 0.05;
const DEFAULT_MAX_FLOORS = 9;

// 難度設定：tiles = 每層格數，traps = 每層陷阱數。
const DIFFICULTIES = {
  easy: { key: "easy", label: "簡單", tiles: 4, traps: 1 },
  medium: { key: "medium", label: "普通", tiles: 3, traps: 1 },
  hard: { key: "hard", label: "困難", tiles: 2, traps: 1 },
  hell: { key: "hell", label: "地獄", tiles: 3, traps: 2 },
};

const DEFAULT_DIFFICULTY = "medium";

function round2(n) {
  return Math.round(n * 100) / 100;
}
function floor2(n) {
  return Math.floor(n * 100) / 100;
}

function resolveDifficulty(key) {
  return DIFFICULTIES[key] || DIFFICULTIES[DEFAULT_DIFFICULTY];
}

// 每層固定倍率：以「安全機率倒數」為公平賠率，再扣房費。
function floorMultiplierFor(tiles, traps, houseEdge = DEFAULT_HOUSE_EDGE) {
  const safe = tiles - traps;
  if (safe <= 0) return 0;
  const edge = Math.max(0, Math.min(0.5, houseEdge));
  const fair = tiles / safe;
  return floor2(fair * (1 - edge));
}

// 在 [0, tiles) 中隨機挑 traps 個不重複位置當陷阱。
function pickTraps(tiles, traps, rng = Math.random) {
  const pool = [];
  for (let i = 0; i < tiles; i += 1) pool.push(i);
  // Fisher-Yates 取前 traps 個
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, traps).sort((a, b) => a - b);
}

function startGame({
  bet,
  difficulty = DEFAULT_DIFFICULTY,
  houseEdge = DEFAULT_HOUSE_EDGE,
  maxFloors = DEFAULT_MAX_FLOORS,
  rng = Math.random,
}) {
  const diff = resolveDifficulty(difficulty);
  const traps = [];
  for (let f = 0; f < maxFloors; f += 1) {
    traps.push(pickTraps(diff.tiles, diff.traps, rng));
  }
  return {
    bet,
    status: "playing",
    difficulty: diff.key,
    tilesPerFloor: diff.tiles,
    trapsPerFloor: diff.traps,
    maxFloors,
    traps,
    currentFloor: 0,
    picks: [],
    hitTile: null,
    floorMultiplier: floorMultiplierFor(diff.tiles, diff.traps, houseEdge),
    accMultiplier: 1,
    houseEdge,
    result: null,
    payout: 0,
  };
}

function isTrap(state, floor, tile) {
  const row = state.traps[floor] || [];
  return row.includes(tile);
}

// 玩家在當前層選一格。
function pick(state, tile) {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(tile) || tile < 0 || tile >= state.tilesPerFloor) {
    return state;
  }
  const floor = state.currentFloor;

  if (isTrap(state, floor, tile)) {
    return finalize(
      {
        ...state,
        picks: [...state.picks, tile],
        hitTile: tile,
      },
      "lose",
      0
    );
  }

  const nextAcc = round2(state.accMultiplier * state.floorMultiplier);
  const next = {
    ...state,
    picks: [...state.picks, tile],
    currentFloor: floor + 1,
    accMultiplier: nextAcc,
  };

  // 爬到頂 → 強制結算
  if (next.currentFloor >= state.maxFloors) {
    return finalize(next, "win", floorPayout(state.bet, nextAcc));
  }
  return next;
}

// 玩家收手。
function cashOut(state) {
  if (state.status !== "playing") return state;
  if (state.currentFloor <= 0) return state; // 沒爬過任何一層不能收
  return finalize(state, "cashout", floorPayout(state.bet, state.accMultiplier));
}

// bet × multiplier 容易踩浮點誤差，加 1e-9 epsilon 後 floor。
function floorPayout(bet, multiplier) {
  return Math.floor(bet * multiplier + 1e-9);
}

function finalize(state, result, payout) {
  return {
    ...state,
    status: "settled",
    result,
    payout,
  };
}

module.exports = {
  startGame,
  pick,
  cashOut,
  isTrap,
  floorMultiplierFor,
  resolveDifficulty,
  round2,
  floor2,
  DIFFICULTIES,
  DEFAULT_DIFFICULTY,
  DEFAULT_HOUSE_EDGE,
  DEFAULT_MAX_FLOORS,
};
