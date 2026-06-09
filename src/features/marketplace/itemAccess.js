const { mining, fishing, farming } = require("../../config");
const orePriceEngine = require("../market/orePriceEngine");

const TYPES = ["ore", "fish", "veggie"];

// 把 marketplaceService 與 itemCatalog 共用的 "veggie" 別名一起接住。
function normalizeType(type) {
  if (type === "crop") return "veggie";
  return type;
}

function bagField(itemType, key) {
  const t = normalizeType(itemType);
  if (t === "ore") return `backpack.${key}`;
  if (t === "fish") return `fish_bag.${key}`;
  if (t === "veggie") return `veggie_bag.${key}`;
  return null;
}

function bagName(itemType) {
  const t = normalizeType(itemType);
  if (t === "fish") return "魚袋";
  if (t === "veggie") return "菜籃";
  return "背包";
}

function bagEmoji(itemType) {
  const t = normalizeType(itemType);
  if (t === "fish") return "🎣";
  if (t === "veggie") return "🌾";
  return "🎒";
}

function getItemDef(itemType, key) {
  const t = normalizeType(itemType);
  if (t === "ore") return mining?.ores?.[key] || null;
  if (t === "fish") return fishing?.fish?.[key] || null;
  if (t === "veggie") return farming?.crops?.[key] || null;
  return null;
}

// 基礎價（給 fee / 最低售價計算用）
function basePrice(itemType, key) {
  const t = normalizeType(itemType);
  if (t === "ore") return mining?.ores?.[key]?.price || 0;
  if (t === "fish") return fishing?.fish?.[key]?.price || 0;
  if (t === "veggie") return orePriceEngine.cropBasePrice(key);
  return 0;
}

function getInventoryQty(profile, itemType, key) {
  const t = normalizeType(itemType);
  if (t === "ore") return profile?.backpack?.[key] || 0;
  if (t === "fish") return profile?.fish_bag?.[key] || 0;
  if (t === "veggie") return profile?.veggie_bag?.[key] || 0;
  return 0;
}

// 物品是否有背包容量限制（只有 ore 走 backpack）
function isCapacityLimited(itemType) {
  return normalizeType(itemType) === "ore";
}

function itemLabel(itemType, key, qty = null) {
  const def = getItemDef(itemType, key) || {};
  const base = `${def.emoji || "📦"} ${def.name || key || "未知物品"}`;
  return qty != null ? `${base} ×${qty}` : base;
}

function allChoices() {
  const out = [];
  for (const [key, def] of Object.entries(mining?.ores || {})) {
    if (!def.price) continue;
    out.push({ name: `⛏️ ${def.name}（礦石）`, value: `ore:${key}` });
  }
  for (const [key, def] of Object.entries(fishing?.fish || {})) {
    out.push({ name: `🐟 ${def.name}（魚類）`, value: `fish:${key}` });
  }
  for (const [key, def] of Object.entries(farming?.crops || {})) {
    out.push({ name: `🌾 ${def.name}（農產品）`, value: `veggie:${key}` });
  }
  return out.slice(0, 25);
}

function parseChoice(value) {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const [rawType, key] = value.split(":");
  const type = normalizeType(rawType);
  if (!TYPES.includes(type)) return null;
  if (!getItemDef(type, key)) return null;
  return { type, key };
}

module.exports = {
  TYPES,
  normalizeType,
  bagField,
  bagName,
  bagEmoji,
  getItemDef,
  basePrice,
  getInventoryQty,
  isCapacityLimited,
  itemLabel,
  allChoices,
  parseChoice,
};
