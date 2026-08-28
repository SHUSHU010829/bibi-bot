// 維修工具的共用挑選與文案。挖礦、釣魚、工坊三邊都要「哪張最划算」與「這張的效果是什麼」，
// 各自複製一份必然漂移（新增魔晶工具時只改到其中一份），所以集中在這裡。

require("colors");
const { craft } = require("../../config");

// 從玩家持有的維修工具中挑一把「最划算」的：優先 max 不降（甚至 +）、其次補得多。
// 回傳 { tier, name, emoji, count, maxDelta, duraPct } 或 null（沒有維修工具）。
function bestRepairTool(repairToolsOwned) {
  const tools = craft?.repairTools || {};
  const owned = Object.entries(tools)
    .map(([tier, def]) => ({
      tier,
      name: def.name,
      emoji: def.emoji,
      count: (repairToolsOwned || {})[tier] || 0,
      maxDelta: def.maxDelta || 0,
      duraPct: def.duraPct || 0,
    }))
    .filter((o) => o.count > 0);
  if (!owned.length) return null;
  owned.sort((a, b) => b.maxDelta - a.maxDelta || b.duraPct - a.duraPct);
  return owned[0];
}

function toolEffectText(def) {
  const deltaTxt = !def.maxDelta
    ? "上限不變"
    : def.maxDelta > 0
      ? `上限 +${def.maxDelta}`
      : `上限 ${def.maxDelta}`;
  return `修復 ${Math.round((def.duraPct || 0) * 100)}% 耐久 ・ ${deltaTxt}`;
}

module.exports = { bestRepairTool, toolEffectText };
