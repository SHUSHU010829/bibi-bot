// 幸運轉盤核心引擎：純函數，不接觸 DB / Discord。
//
// 玩法：一個由多個加權扇形組成的轉盤，每個扇形帶一個倍率。
//   旋轉時依權重抽中一個扇形，payout = floor(bet × segment.mult)。
//   mult = 0 代表槓龜，下注全沒。
//
// RTP = Σ(weight × mult) / Σweight；房費由權重控制（預設約 6–10%）。
// 預設權重已調至 RTP ≈ 0.929（房費約 7.1%），含稀有大獎 ×50（約 0.1% 機率）。

const DEFAULT_SEGMENTS = [
  { mult: 0, weight: 470, label: "槓龜", emoji: "💀" },
  { mult: 1.2, weight: 240, label: "×1.2", emoji: "🪙" },
  { mult: 1.5, weight: 160, label: "×1.5", emoji: "🪙" },
  { mult: 2, weight: 90, label: "×2", emoji: "✨" },
  { mult: 3, weight: 28, label: "×3", emoji: "💎" },
  { mult: 5, weight: 10, label: "×5", emoji: "💎" },
  { mult: 10, weight: 4, label: "×10", emoji: "🎉" },
  { mult: 50, weight: 1, label: "大獎 ×50", emoji: "👑" },
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
