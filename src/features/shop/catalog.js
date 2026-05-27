const { shop } = require("../../config");

// 可一次購買多筆（數量會累加）的商品型別。其餘（身份組／卡面／稱號／加成藥水）一次只買 1 筆。
const STACKABLE_TYPES = [
  "mining_luck_potion",
  "mining_cd_ticket",
  "mining_backpack",
  "casino_token",
];

function getCatalog() {
  return Array.isArray(shop?.items) ? shop.items : [];
}

function isStackable(item) {
  return !!item && STACKABLE_TYPES.includes(item.type);
}

// 單次購買的數量上限：CD 縮短券吃持有上限（maxStack），其餘給一個合理的天花板。
function stackMax(item) {
  if (!isStackable(item)) return 1;
  if (item.type === "mining_cd_ticket" && item.payload?.maxStack > 0) {
    return item.payload.maxStack;
  }
  return 50;
}

function getItem(itemId) {
  return getCatalog().find((i) => i.id === itemId) || null;
}

function getCategories() {
  const set = new Set();
  for (const item of getCatalog()) {
    if (item.category) set.add(item.category);
  }
  return Array.from(set);
}

function getTheme(themeId) {
  const themes = shop?.themes || {};
  return themes[themeId] || themes.default || null;
}

module.exports = {
  getCatalog,
  getItem,
  getCategories,
  getTheme,
  isStackable,
  stackMax,
  STACKABLE_TYPES,
};
