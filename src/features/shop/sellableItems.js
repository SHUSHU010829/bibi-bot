const { getItem } = require("./catalog");

// 從 /背包 的「賣出」按鈕開啟「輸入數量」彈窗：sellm_open_<ownerId>_<itemType>_<itemKey>
// 彈窗送出後的 customId：sellm_qty_<ownerId>_<itemType>_<itemKey>
// itemType 為 ore/fish/veggie/item（無底線），itemKey 可含底線 → 用 split 後首二段解析。
const SELL_MODAL_OPEN_PREFIX = "sellm_open_";
const SELL_MODAL_QTY_PREFIX = "sellm_qty_";

function parseSellTarget(rest) {
  if (!rest) return null;
  const parts = rest.split("_");
  if (parts.length < 3) return null;
  const [ownerId, itemType, ...keyParts] = parts;
  const itemKey = keyParts.join("_");
  if (!ownerId || !itemType || !itemKey) return null;
  return { ownerId, itemType, itemKey };
}

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

module.exports = {
  getSellableItem,
  sellableChoices,
  SELLABLE,
  SELL_MODAL_OPEN_PREFIX,
  SELL_MODAL_QTY_PREFIX,
  parseSellTarget,
};
