const { getItem } = require("./catalog");

// 從 /背包 的「賣出」按鈕開啟賣道具確認：sell_item_open_<ownerId>_<itemKey>
const SELL_ITEM_OPEN_PREFIX = "sell_item_open_";

// 可賣回系統的商店道具：itemKey → 持有量所在的 profile 欄位、顯示用 emoji / 單位。
// 名稱與賣價（sellPrice）一律讀 shop.json 該商品定義，這裡只補「存哪個欄位 / 怎麼顯示」。
// 要再開放其他道具可賣，shop.json 補 sellPrice，再來這裡加一條對應欄位即可。
const SELLABLE = {
  mining_whetstone_inferior: { field: "whetstone_inferior_count", emoji: "🪨", unit: "個" },
};

function getSellableItem(itemKey) {
  const meta = SELLABLE[itemKey];
  if (!meta) return null;
  const def = getItem(itemKey);
  if (!def || typeof def.sellPrice !== "number" || def.sellPrice <= 0) return null;
  return {
    key: itemKey,
    name: def.name,
    emoji: meta.emoji,
    unit: meta.unit,
    field: meta.field,
    sellPrice: def.sellPrice,
  };
}

function sellableChoices() {
  return Object.keys(SELLABLE)
    .map(getSellableItem)
    .filter(Boolean)
    .map((s) => ({ name: `${s.name}（道具）`, value: `item:${s.key}` }));
}

module.exports = { getSellableItem, sellableChoices, SELLABLE, SELL_ITEM_OPEN_PREFIX };
