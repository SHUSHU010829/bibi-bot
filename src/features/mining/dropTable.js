const { mining } = require("../../config");
const { weightedRandom } = require("./weightedRandom");
const eventEngine = require("../event/eventEngine");

// 礦石來源：基礎礦石 + 生效中限時活動注入的限定礦石（Phase S5）。
function oreDefs() {
  return eventEngine.getEffectiveOreDefs();
}

// 依 luckBonus 調整後的權重抽一種礦石。
// luck 透過每種礦的 luckFactor 放大稀有礦的權重：weight * (1 + luckBonus * luckFactor)。
// 普通礦 luckFactor=0 不變，正規化後其相對占比會隨稀有礦變大而下降。
function adjustedWeights(luckBonus = 0) {
  const ores = oreDefs();
  const weights = {};
  for (const [key, def] of Object.entries(ores)) {
    const base = def.weight || 0;
    const factor = def.luckFactor || 0;
    weights[key] = base * (1 + luckBonus * factor);
  }
  return weights;
}

function roll(luckBonus = 0) {
  return weightedRandom(adjustedWeights(luckBonus));
}

// 決定掉落數量：[minQty, maxQty] 均勻分布後加 qtyBonus。
function randQty(oreKey, qtyBonus = 0) {
  const def = oreDefs()[oreKey] || mining?.ores?.[oreKey];
  if (!def) return 1;
  const min = def.minQty ?? 1;
  const max = def.maxQty ?? min;
  const base = Math.floor(Math.random() * (max - min + 1)) + min;
  return base + (qtyBonus || 0);
}

module.exports = { roll, randQty, adjustedWeights };
