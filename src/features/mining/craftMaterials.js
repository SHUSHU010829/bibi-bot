// 合成材料的單一真實來源：持有量查詢 + 中文標籤。
// /合成、工坊合成分頁、按鈕 handler 一律走這裡，避免各自維護而分岔
// （例：碎片持有量讀錯欄位、錯誤訊息印出英文 id）。

const { mining, craft, fishing } = require("../../config");

// 特殊材料走 profile 獨立欄位，不在 backpack 內。
const SPECIAL_MAT_FIELDS = {
  legendary_fragment: "legendary_fragments",
  broken_net_fragment: "broken_net_fragments",
  broken_trap_fragment: "broken_trap_fragments",
  treasure_map_fragment: "treasure_map_fragments",
};

function isFishMaterial(mat) {
  return !!(fishing?.fish && fishing.fish[mat]);
}

// 玩家目前持有某材料的數量（特殊材料走獨立欄位、魚走 fish_bag、其餘走 backpack）。
function ownedMaterial(profile, mat) {
  if (SPECIAL_MAT_FIELDS[mat]) return profile[SPECIAL_MAT_FIELDS[mat]] || 0;
  if (isFishMaterial(mat)) return (profile.fish_bag || {})[mat] || 0;
  return (profile.backpack || {})[mat] || 0;
}

// 材料定義（含 name / emoji）：特殊材料 → 魚 → 礦石。
function materialDef(mat) {
  const special = (craft?.materials || {})[mat];
  if (special) return special;
  if (isFishMaterial(mat)) return fishing.fish[mat];
  return mining?.ores?.[mat] || mining?.specialOres?.[mat] || null;
}

// 中文材料標籤；帶 qty 時附 ×N。永遠不會印出原始 snake_case id。
function materialLabel(mat, qty) {
  const def = materialDef(mat);
  const emoji = def?.emoji || (isFishMaterial(mat) ? "🐟" : "⛏️");
  const name = def?.name || mat;
  const base = `${emoji} ${name}`.trim();
  return qty == null ? base : `${base} ×${qty}`;
}

module.exports = {
  SPECIAL_MAT_FIELDS,
  isFishMaterial,
  ownedMaterial,
  materialDef,
  materialLabel,
};
