const { guildWarehouse, farming } = require("../../config");

// 世界事件徵集物資的中文名稱表（單一來源，view 與公告共用）。
// 多數需求是公會倉庫物資（礦 / 魚 / 菜），但少數是只存在於玩家背包的稀有材料
// （例：月光露水），它們不在 guildWarehouse.items，需回退到肥料設定，
// 否則 UI 會直接印出英文 id。
function fertilizerByBackpackKey(itemId) {
  const ferts = farming?.fertilizers || {};
  for (const f of Object.values(ferts)) {
    if (f.source === "backpack" && f.key === itemId && f.name) return f;
  }
  return null;
}

// 逼幣不是倉庫物資也不是背包道具，但主線活動會徵集它，得有中文名。
const CURRENCY_META = { name: "逼幣", emoji: "🪙" };

function itemMeta(id) {
  if (id === "coins") return CURRENCY_META;
  return guildWarehouse?.items?.[id] || fertilizerByBackpackKey(id) || null;
}

const itemLabel = (id) => itemMeta(id)?.name || id;
const itemEmoji = (id) => itemMeta(id)?.emoji || "📦";

module.exports = { itemLabel, itemEmoji };
