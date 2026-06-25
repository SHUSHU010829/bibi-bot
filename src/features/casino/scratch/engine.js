// 刮刮樂（對中獎號碼版）核心引擎：純函數，不接觸 DB / Discord。
//
// 玩法（台灣彩券最經典的「對中獎號碼」）：
//   - 卡面上方有幾個「幸運號碼」（明示，不用刮）。
//   - 下方 3×3 共 9 格「你的號碼」，每格是一組號碼 + 該格的中獎倍率。
//   - 玩家逐格刮或一次全刮；只要你的號碼**對中任一個幸運號碼**，就贏該格倍率。
//   - 可同時對中多格，payout = floor(bet × 所有對中格倍率加總)；沒對中 = 0。
//   - 全部刮開後才結算（給玩家刮的樂趣）。
//
// 中獎與否在買卡當下就由加權獎項表抽定（像真實預印刮刮樂）：
//   抽到 prize.matches = [m1, m2, ...]：佈成「恰 K 格號碼 = 幸運號碼、倍率依序 = m_i」，
//                                       其餘 (9-K) 格號碼不對中、倍率用誘餌值（看得到、刮不中）。
//   抽到 matches = []（K=0）：9 格號碼全不對中。
// 總倍率 M = Σ m_i；EV = Σ(weight × M) / Σweight，房費由權重控制。

const DEFAULT_LUCKY_COUNT = 3;
const DEFAULT_NUMBER_MAX = 99;
const DEFAULT_DECOYS = [1, 1.5, 2, 3, 5];

function floorPayout(bet, multiplier) {
  return Math.floor(bet * multiplier + 1e-9);
}

function pickPrize(prizes, rng = Math.random) {
  const total = prizes.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (const p of prizes) {
    r -= p.weight;
    if (r < 0) return p;
  }
  return prizes[prizes.length - 1];
}

// 把獎項正規化成 matches 陣列。兼容舊格式 { mult, weight }（單格中獎）。
function normalizeMatches(prize) {
  if (Array.isArray(prize.matches)) return prize.matches.slice();
  const m = Number(prize.mult) || 0;
  return m > 0 ? [m] : [];
}

// 從 [1, max] 取 count 個互不重複、且不在 exclude 內的號碼。
// 用「建池 → 洗牌 → 取前 count 個」，保證 O(max) 完成、不會卡迴圈。
function sampleNumbers(count, max, exclude, rng) {
  const pool = [];
  for (let n = 1; n <= max; n += 1) {
    if (!exclude.has(n)) pool.push(n);
  }
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// 從 [0..8] 取 count 個不重複格位（同樣建池+洗牌）。
function sampleIndices(count, rng) {
  const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function startGame({
  bet,
  prizes,
  luckyCount = DEFAULT_LUCKY_COUNT,
  numberMax = DEFAULT_NUMBER_MAX,
  decoys = DEFAULT_DECOYS,
  rng = Math.random,
}) {
  const prize = pickPrize(prizes, rng);
  const matches = normalizeMatches(prize);
  const totalMultiplier = matches.reduce((s, m) => s + m, 0);
  const matchCount = matches.length;

  const luckyNumbers = sampleNumbers(luckyCount, numberMax, new Set(), rng);
  const luckySet = new Set(luckyNumbers);

  const winIndices = matchCount > 0 ? sampleIndices(matchCount, rng) : [];
  const winSet = new Set(winIndices);

  const nonMatchCount = 9 - matchCount;
  const nonMatch = sampleNumbers(nonMatchCount, numberMax, luckySet, rng);

  // 把 matches 隨機分配到 winIndices（避免「第一個刮到的永遠是最大那格」之類的偏向）。
  const shuffledMatches = matches.slice();
  for (let i = shuffledMatches.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledMatches[i], shuffledMatches[j]] = [shuffledMatches[j], shuffledMatches[i]];
  }
  const indexToMult = new Map();
  winIndices.forEach((idx, i) => indexToMult.set(idx, shuffledMatches[i]));

  const cells = [];
  let nmIdx = 0;
  for (let i = 0; i < 9; i += 1) {
    if (winSet.has(i)) {
      const num = luckyNumbers[Math.floor(rng() * luckyNumbers.length)];
      cells.push({ number: num, prize: indexToMult.get(i) });
    } else {
      const decoy = decoys[Math.floor(rng() * decoys.length)];
      cells.push({ number: nonMatch[nmIdx++], prize: decoy });
    }
  }

  return {
    bet,
    status: "playing",
    luckyNumbers,
    cells,
    winIndices,
    matchCount,
    revealed: [],
    multiplier: totalMultiplier,
    result: null,
    payout: 0,
  };
}

// 某格的號碼是否對中幸運號碼。
function isMatch(state, idx) {
  return state.luckyNumbers.includes(state.cells[idx].number);
}

function scratch(state, idx) {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(idx) || idx < 0 || idx >= 9) return state;
  if (state.revealed.includes(idx)) return state;
  return { ...state, revealed: [...state.revealed, idx] };
}

function scratchAll(state) {
  if (state.status !== "playing") return state;
  return { ...state, revealed: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
}

function isFullyRevealed(state) {
  return state.revealed.length >= 9;
}

// 結算：加總所有對中格的 prize 倍率（與買卡時抽定的 matches 加總一致）。
function settle(state) {
  if (state.status !== "playing") return state;
  let totalMult = 0;
  let matched = 0;
  for (let i = 0; i < state.cells.length; i += 1) {
    if (isMatch(state, i)) {
      totalMult += state.cells[i].prize;
      matched += 1;
    }
  }
  const win = totalMult > 0;
  return {
    ...state,
    status: "settled",
    matchCount: matched,
    multiplier: totalMult,
    result: win ? "win" : "lose",
    payout: win ? floorPayout(state.bet, totalMult) : 0,
  };
}

module.exports = {
  startGame,
  scratch,
  scratchAll,
  isFullyRevealed,
  settle,
  isMatch,
  pickPrize,
  floorPayout,
  normalizeMatches,
  DEFAULT_LUCKY_COUNT,
  DEFAULT_NUMBER_MAX,
  DEFAULT_DECOYS,
};
