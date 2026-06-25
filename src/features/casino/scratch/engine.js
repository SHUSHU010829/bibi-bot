// 刮刮樂（Scratch）核心引擎：純函數，不接觸 DB / Discord。
//
// 規則：
//   - 一張 9 格（3×3）刮刮卡，玩家逐格刮開或一次全刮。
//   - 中獎與否在「買卡當下」就由加權獎項表抽定（像真實刮刮樂的預印結果），
//     刮開只是揭曉過程：卡面湊滿 3 個相同中獎符號 → 中該獎倍率。
//   - payout = floor(bet × multiplier)；沒中 = 0。
//   - 全部刮開後才結算派彩（給玩家刮的樂趣）。
//
// 獎項表（config.prizes）每項 { mult, weight, symbol }；mult=0 代表槓龜。
// EV = Σ(weight×mult) / Σweight，房費直接由權重控制。
//
// 佈卡：
//   中獎 → 放 3 個中獎符號 + 6 個填充符號（保證沒有別的符號也湊到 3）。
//   槓龜 → 9 格填充符號，保證沒有任何符號達到 3 個。

// 填充用符號池（與獎項符號可重疊，但佈卡時會控制每種 ≤2 個）。
const FILLERS = ["🍋", "🍒", "🔔", "7️⃣", "💎", "👑", "🍀", "🪙", "🎰"];

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

// 洗牌（Fisher-Yates）。
function shuffle(arr, rng = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 從填充池逐一補滿到 9 格，且任何符號（含已放入的中獎符號）都不超過 2 個。
function fillGrid(cells, exclude, rng = Math.random) {
  const counts = {};
  for (const c of cells) counts[c] = (counts[c] || 0) + 1;
  const pool = shuffle(FILLERS, rng);
  while (cells.length < 9) {
    let placed = false;
    for (const sym of pool) {
      if (sym === exclude) continue; // 中獎符號不再多放，避免超過 3
      if ((counts[sym] || 0) < 2) {
        cells.push(sym);
        counts[sym] = (counts[sym] || 0) + 1;
        placed = true;
        break;
      }
    }
    // 理論上 9 種填充符號 ×2 = 18 個容量，永遠夠補滿 9 格
    if (!placed) cells.push(pool[0]);
  }
  return cells;
}

function buildGrid(prize, rng = Math.random) {
  const win = prize.mult > 0;
  let cells = [];
  if (win) {
    cells = [prize.symbol, prize.symbol, prize.symbol];
    fillGrid(cells, prize.symbol, rng);
  } else {
    fillGrid(cells, null, rng);
  }
  return shuffle(cells, rng);
}

function startGame({ bet, prizes, rng = Math.random }) {
  const prize = pickPrize(prizes, rng);
  const grid = buildGrid(prize, rng);
  return {
    bet,
    status: "playing",
    grid,
    revealed: [],
    winSymbol: prize.mult > 0 ? prize.symbol : null,
    multiplier: prize.mult,
    result: null,
    payout: 0,
  };
}

// 刮開一格。回傳更新後 state（不結算）。
function scratch(state, idx) {
  if (state.status !== "playing") return state;
  if (!Number.isInteger(idx) || idx < 0 || idx >= 9) return state;
  if (state.revealed.includes(idx)) return state;
  return { ...state, revealed: [...state.revealed, idx] };
}

// 全部刮開。
function scratchAll(state) {
  if (state.status !== "playing") return state;
  return { ...state, revealed: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
}

function isFullyRevealed(state) {
  return state.revealed.length >= 9;
}

// 結算（在全部刮開後呼叫）。
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
  pickPrize,
  buildGrid,
  floorPayout,
  FILLERS,
};
