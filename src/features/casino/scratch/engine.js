// 刮刮樂（對中獎號碼版）核心引擎：純函數，不接觸 DB / Discord。
//
// 玩法（台灣彩券最經典的「對中獎號碼」）：
//   - 卡面上方有幾個「幸運號碼」（明示，不用刮）。
//   - 下方 3×3 共 9 格「你的號碼」，每格是一組號碼 + 該格的中獎倍率。
//   - 玩家逐格刮或一次全刮；只要你的號碼**對中任一個幸運號碼**，就贏該格倍率。
//   - payout = floor(bet × 中獎格倍率)；沒對中 = 0。
//   - 全部刮開後才結算（給玩家刮的樂趣）。
//
// 中獎與否在買卡當下就由加權獎項表抽定（像真實預印刮刮樂）：
//   抽到倍率 M：佈成「恰一格號碼 = 幸運號碼、倍率 = M」，其餘 8 格號碼不對中、
//               倍率用誘餌值（看得到、刮不中）。
//   抽到 0：9 格號碼全不對中。
// EV = Σ(weight×mult) / Σweight，房費由權重控制。

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

function startGame({
  bet,
  prizes,
  luckyCount = DEFAULT_LUCKY_COUNT,
  numberMax = DEFAULT_NUMBER_MAX,
  decoys = DEFAULT_DECOYS,
  rng = Math.random,
}) {
  const prize = pickPrize(prizes, rng);
  const multiplier = prize.mult;
  const win = multiplier > 0;

  const luckyNumbers = sampleNumbers(luckyCount, numberMax, new Set(), rng);
  const luckySet = new Set(luckyNumbers);

  const winIndex = win ? Math.floor(rng() * 9) : -1;

  // 先把 8（或 9）個「不對中」的號碼一次抽好，避免跟幸運號碼或彼此重複。
  const nonMatchCount = win ? 8 : 9;
  const nonMatch = sampleNumbers(nonMatchCount, numberMax, luckySet, rng);

  const cells = [];
  let nmIdx = 0;
  for (let i = 0; i < 9; i += 1) {
    if (win && i === winIndex) {
      const num = luckyNumbers[Math.floor(rng() * luckyNumbers.length)];
      cells.push({ number: num, prize: multiplier });
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
    winIndex: win ? winIndex : null,
    revealed: [],
    multiplier,
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

function settle(state) {
  if (state.status !== "playing") return state;
  const win = state.multiplier > 0;
  return {
    ...state,
    status: "settled",
    result: win ? "win" : "lose",
    payout: win ? floorPayout(state.bet, state.multiplier) : 0,
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
  DEFAULT_LUCKY_COUNT,
  DEFAULT_NUMBER_MAX,
  DEFAULT_DECOYS,
};
