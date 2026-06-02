const { mining, farming, fishing } = require("../../config");

const TYPES = ["ore", "crop", "fish"];

function getItemDef(type, key) {
  if (type === "ore") {
    const def = mining?.ores?.[key];
    if (!def) return null;
    return { type, key, name: def.name, emoji: def.emoji || "⛏️", price: def.price || 0 };
  }
  if (type === "crop") {
    const def = farming?.crops?.[key];
    const price = farming?.sellPrices?.[key];
    if (!def || price == null) return null;
    return { type, key, name: def.name, emoji: def.emoji || "🌱", price };
  }
  if (type === "fish") {
    const def = fishing?.fish?.[key];
    if (!def) return null;
    return { type, key, name: def.name, emoji: def.emoji || "🐟", price: def.price || 0 };
  }
  return null;
}

function listAllChoices() {
  const out = [];
  for (const key of Object.keys(mining?.ores || {})) {
    const def = getItemDef("ore", key);
    if (def) out.push({ name: `⛏️ ${def.name}`, value: `ore:${key}` });
  }
  for (const key of Object.keys(farming?.crops || {})) {
    const def = getItemDef("crop", key);
    if (def) out.push({ name: `🌱 ${def.name}`, value: `crop:${key}` });
  }
  for (const key of Object.keys(fishing?.fish || {})) {
    const def = getItemDef("fish", key);
    if (def) out.push({ name: `🐟 ${def.name}`, value: `fish:${key}` });
  }
  return out.slice(0, 25);
}

function parseChoice(value) {
  if (typeof value !== "string" || !value.includes(":")) return null;
  const [type, key] = value.split(":");
  if (!TYPES.includes(type)) return null;
  return { type, key };
}

module.exports = { getItemDef, listAllChoices, parseChoice, TYPES };
