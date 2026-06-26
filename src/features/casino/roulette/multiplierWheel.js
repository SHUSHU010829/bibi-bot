// 倍率轉盤核心引擎：純函數，不接觸 DB / Discord。
//
// 玩法：一個由等分扇形組成的環，每個扇形帶一個倍率 mult（0 = 沒中）。
//   玩家先選一個倍率 choice（×2 / ×5 / ×10），轉盤隨機停在一格。
//   只有停在「等於 choice 的倍率」才中獎，payout = floor(bet × choice)。
//   停在 0 或別的倍率都算槓龜。
//
// 每一種選擇的 RTP = P(該倍率) × 該倍率。
//   預設 22 等分：×2:10、×5:4、×10:2、0:6
//     ×2  → 10/22 × 2 ≈ 0.909
//     ×5  →  4/22 × 5 ≈ 0.909
//     ×10 →  2/22 × 10 ≈ 0.909
//   三種選擇 RTP 一致，房費約 9%。
//
// 0 扇形刻意散佈在各倍率群之間，讓「沒中」的格子在轉盤上四處可見，
// 而不是擠成一塊。

const DEFAULT_SEGMENTS = [
  { mult: 2 },
  { mult: 2 },
  { mult: 0 },
  { mult: 5 },
  { mult: 2 },
  { mult: 2 },
  { mult: 0 },
  { mult: 10 },
  { mult: 2 },
  { mult: 2 },
  { mult: 0 },
  { mult: 5 },
  { mult: 2 },
  { mult: 2 },
  { mult: 0 },
  { mult: 10 },
  { mult: 2 },
  { mult: 2 },
  { mult: 0 },
  { mult: 5 },
  { mult: 0 },
  { mult: 5 },
];

function normalize(segments) {
  return Array.isArray(segments) && segments.length ? segments : DEFAULT_SEGMENTS;
}

function spin({ bet, choice, segments = DEFAULT_SEGMENTS, rng = Math.random }) {
  const ring = normalize(segments);
  const pick = Number(choice) || 0;
  const winningIndex = Math.floor(rng() * ring.length) % ring.length;
  const landedMult = Number(ring[winningIndex]?.mult) || 0;
  const won = landedMult === pick && pick > 0;
  const payout = won ? Math.floor(bet * pick) : 0;
  return {
    winningIndex,
    landedMult,
    choice: pick,
    won,
    payout,
    net: payout - bet,
  };
}

// 各倍率選擇的理論 RTP：P(landedMult === choice) × choice。
function rtpByChoice(segments = DEFAULT_SEGMENTS) {
  const ring = normalize(segments);
  const total = ring.length;
  const counts = new Map();
  for (const seg of ring) {
    const m = Number(seg?.mult) || 0;
    if (m <= 0) continue;
    counts.set(m, (counts.get(m) || 0) + 1);
  }
  const out = {};
  for (const [mult, count] of counts) {
    out[mult] = (count / total) * mult;
  }
  return out;
}

module.exports = {
  DEFAULT_SEGMENTS,
  spin,
  rtpByChoice,
};
