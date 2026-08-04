require("colors");
const { craft } = require("../../config");

// 陷阱分兩階：鐵礦打造的簡易陷阱好取得但有機率失效，碎片打造的高級陷阱必定抵擋。
// 兩階共用同一個「總抵擋次數」上限，抵擋時由弱到強消耗（把可靠的留到後面）。
// 名稱 / 欄位 / 機率一律從這裡查，不要在各 view 各自複製一份。

const cfg = () => craft?.advancedTrap || {};

const FALLBACK = {
  advanced: { name: "高級陷阱", emoji: "⚙️", field: "advanced_trap_uses", blocksPerCraft: 4, blockChance: 1 },
};

// 弱 → 強，消耗順序與顯示順序都照這個
function tiers() {
  const t = cfg().tiers || FALLBACK;
  return Object.entries(t)
    .map(([id, def]) => ({ id, ...def }))
    .sort((a, b) => (a.blockChance ?? 1) - (b.blockChance ?? 1));
}

function trapTier(id) {
  const list = tiers();
  return list.find((t) => t.id === id) || list[list.length - 1];
}

const maxStack = () => cfg().maxStack ?? 12;

function usesOf(profile, tierId) {
  return profile?.[trapTier(tierId).field] || 0;
}

function totalTrapUses(profile) {
  return tiers().reduce((s, t) => s + (profile?.[t.field] || 0), 0);
}

// 玩家可見的持有摘要，例：「🪤 簡易陷阱 ×4（70% 抵擋）・⚙️ 高級陷阱 ×8」
function describeHoldings(profile) {
  return tiers()
    .filter((t) => (profile?.[t.field] || 0) > 0)
    .map((t) => {
      const pct = Math.round((t.blockChance ?? 1) * 100);
      const rate = pct >= 100 ? "" : `（${pct}% 抵擋）`;
      return `${t.emoji || "🪤"} ${t.name} ×${profile[t.field]}${rate}`;
    });
}

module.exports = { tiers, trapTier, maxStack, usesOf, totalTrapUses, describeHoldings };
