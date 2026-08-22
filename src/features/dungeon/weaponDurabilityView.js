// 武器名稱與耐久警告文案的單一來源：地下城結算面板、深層樓層面板、出戰面板、
// 農地防禦戰結果都共用這裡，避免某條路徑忘了提示玩家武器快斷。
const { dungeon } = require("../../config");

function weaponLabel(key) {
  const def = (dungeon?.weapons || {})[key] || {};
  return `${def.emoji || "👊"} ${def.name || key}`;
}

// 警告門檻要跟著「這場扣多少耐久」放大：深層樓層 / mini-BOSS 一場扣 4–5，
// 固定門檻（剩 5 才提醒）會讓高階武器一場就從安全值直接斷掉、玩家完全沒被提醒過。
function warnThresholds(cost) {
  const warn = dungeon?.durabilityWarn || {};
  const per = Math.max(1, cost || 1);
  return {
    critical: Math.max(warn.critical ?? 0, per),
    low: Math.max(warn.low ?? 0, per * (warn.lowBattles ?? 3)),
  };
}

// 低於門檻時回警告文案，還很健康則回 null（由呼叫端印自己的中性行）。
// cost：這場戰鬥會扣掉的耐久（不給就用一般地下城的 1）。
function weaponDurabilityWarnLine(weaponKey, after, cost = 1) {
  const th = warnThresholds(cost);
  const label = weaponLabel(weaponKey);
  const per = Math.max(1, cost || 1);
  const costTail = per > 1 ? `（這場耐久 -${per}）` : "";
  if (after <= th.critical) {
    return `🚨 **武器快斷了！**\n${label} 只剩 **${after}** 次${costTail}，再戰就會斷裂退回赤手空拳。快去 \`/合成\` 一把新的、或到 \`/裝備\` 用礦石修復耐久！`;
  }
  if (after <= th.low) {
    return `⚠️ **武器耐久偏低**\n${label} 剩 **${after}** 次${costTail}，大約只夠再打 **${Math.floor(after / per)}** 場，建議先去 \`/合成\` 備一把、或到 \`/裝備\` 用礦石修復耐久。`;
  }
  return null;
}

module.exports = { weaponLabel, weaponDurabilityWarnLine, warnThresholds };
