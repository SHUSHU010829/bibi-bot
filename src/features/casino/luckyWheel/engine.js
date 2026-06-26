// 幸運轉盤核心引擎：純函數，不接觸 DB / Discord。
//
// 玩法：一個由多個加權扇形組成的轉盤，每個扇形帶一個倍率（含 < 1 的「少賠」格）。
//   旋轉時依權重抽中一個扇形，payout = floor(bet × segment.mult)。
//   沒有槓龜（×0）：最低也會拿回一部分本金，只是少賠。
//
// RTP = Σ(weight × mult) / Σweight；房費由權重控制。預設 17 格、RTP ≈ 0.90，
// 含稀有大獎 ×25 / ×50 / ×100。
// 順序＝轉盤上的視覺排列：< 1 的「少賠」格刻意穿插在中獎格之間，不集中成一塊
//（機率只看 weight，與排列無關）。
const DEFAULT_SEGMENTS = [
  { mult: 0.5, weight: 231, label: "×0.5" },
  { mult: 2, weight: 52, label: "×2" },
  { mult: 100, weight: 0.25, label: "大獎 ×100" },
  { mult: 0.2, weight: 173, label: "×0.2" },
  { mult: 1.5, weight: 72, label: "×1.5" },
  { mult: 3, weight: 24, label: "×3" },
  { mult: 0.7, weight: 231, label: "×0.7" },
  { mult: 25, weight: 1.6, label: "×25" },
  { mult: 1.2, weight: 95, label: "×1.2" },
  { mult: 0.3, weight: 187, label: "×0.3" },
  { mult: 6, weight: 9, label: "×6" },
  { mult: 0.8, weight: 231, label: "×0.8" },
  { mult: 2.5, weight: 34, label: "×2.5" },
  { mult: 50, weight: 0.6, label: "×50" },
  { mult: 0.6, weight: 231, label: "×0.6" },
  { mult: 4, weight: 15, label: "×4" },
  { mult: 10, weight: 5, label: "×10" },
];

function floorPayout(bet, mult) {
  return Math.floor(bet * mult + 1e-9);
}

function pickSegment(segments, rng = Math.random) {
  const total = segments.reduce((s, p) => s + p.weight, 0);
  let r = rng() * total;
  for (let i = 0; i < segments.length; i++) {
    r -= segments[i].weight;
    if (r < 0) return { segment: segments[i], index: i };
  }
  const last = segments.length - 1;
  return { segment: segments[last], index: last };
}

function spin({ bet, segments = DEFAULT_SEGMENTS, rng = Math.random }) {
  const list = Array.isArray(segments) && segments.length ? segments : DEFAULT_SEGMENTS;
  const { segment, index } = pickSegment(list, rng);
  const mult = Number(segment.mult) || 0;
  const payout = floorPayout(bet, mult);
  const win = payout > bet;
  return {
    segment,
    segmentIndex: index,
    mult,
    payout,
    result: payout > 0 ? "win" : "lose",
    net: payout - bet,
    isProfit: win,
  };
}

function rtp(segments = DEFAULT_SEGMENTS) {
  const total = segments.reduce((s, p) => s + p.weight, 0);
  const weighted = segments.reduce((s, p) => s + p.weight * p.mult, 0);
  return weighted / total;
}

module.exports = {
  DEFAULT_SEGMENTS,
  pickSegment,
  spin,
  rtp,
  floorPayout,
};
