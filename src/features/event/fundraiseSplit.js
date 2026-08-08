// 募資活動的獎勵分配：名次一多就沒辦法用 modal 逐名填金額（Discord 一個 modal 最多 5 欄），
// 所以獎金與物品都照 config 的固定比例自動拆下來。
const { eventFundraise } = require("../../config");

function cfg() {
  return eventFundraise || {};
}

function maxRankCount() {
  const n = cfg().maxRankCount;
  return Number.isFinite(n) ? n : 10;
}

// config 沒有這個名次數的比例表時，退回「權重遞減」自動正規化（n, n-1, ... 1）。
function splitPercents(rankCount) {
  const preset = (cfg().prizeSplits || {})[String(rankCount)];
  if (Array.isArray(preset) && preset.length === rankCount) return preset;
  const weights = Array.from({ length: rankCount }, (_, i) => rankCount - i);
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w * 100) / total);
}

function formatPercent(pct) {
  return `${Math.round(pct * 10) / 10}%`;
}

function percentLabel(rankCount) {
  return splitPercents(rankCount).map(formatPercent).join(" / ");
}

// 依比例把整數 total 拆成 rankCount 份：先無條件捨去，餘數用最大餘數法補回去（同餘時名次高的先拿）。
// 加總必定等於 total —— 募資池的規則就是一毛不剩全部發完。
function distribute(total, rankCount) {
  if (rankCount <= 0) return [];
  if (total <= 0) return new Array(rankCount).fill(0);

  const pcts = splitPercents(rankCount);
  const sum = pcts.reduce((a, b) => a + b, 0) || 1;
  const raw = pcts.map((p) => (total * p) / sum);
  const shares = raw.map((v) => Math.floor(v));

  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let left = total - shares.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k += 1, left -= 1) {
    shares[order[k % rankCount].i] += 1;
  }
  return shares;
}

// 物品獎池照同一份比例拆；拆到 0 的名次就不會拿到那項物品。回傳 rank → [{value, qty}]。
function splitItems(itemPool = [], rankCount) {
  const byRank = new Map();
  for (const pooled of itemPool) {
    distribute(pooled.qty, rankCount).forEach((qty, idx) => {
      if (qty <= 0) return;
      const rank = idx + 1;
      if (!byRank.has(rank)) byRank.set(rank, []);
      byRank.get(rank).push({ value: pooled.value, qty });
    });
  }
  return byRank;
}

module.exports = {
  maxRankCount,
  splitPercents,
  percentLabel,
  formatPercent,
  distribute,
  splitItems,
};
