// 烹飪材料名稱表（唯一一份）：魚、蔬菜、煤炭的中文標籤。
// command / view / button handler 全部共用，避免某一份漏更新而印出英文 id。

const { fishing } = require("../../config");

const COAL_EMOJI = "<:ore_coal:1509063448481366106>";

const VEGGIE_LABELS = {
  carrot: { emoji: "🥕", name: "紅蘿蔔" },
  corn: { emoji: "🌽", name: "玉米" },
  strawberry: { emoji: "🍓", name: "草莓" },
  black_rose: { emoji: "🌹", name: "黑玫瑰" },
};

function fishDef(key) {
  return (fishing?.fish || {})[key] || {};
}
function veggieDef(key) {
  return VEGGIE_LABELS[key] || {};
}

function fishLabel(key) {
  const d = fishDef(key);
  return `${d.emoji || "🐟"} ${d.name || key}`;
}
function veggieLabel(key) {
  const d = veggieDef(key);
  return `${d.emoji || "🌱"} ${d.name || key}`;
}
function coalLabel() {
  return `${COAL_EMOJI} 煤炭`;
}

module.exports = {
  COAL_EMOJI,
  VEGGIE_LABELS,
  fishDef,
  veggieDef,
  fishLabel,
  veggieLabel,
  coalLabel,
};
