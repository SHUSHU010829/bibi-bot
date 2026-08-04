// 全站唯一的「可轉移物品」名稱表：礦石／作物／魚（背包 map）＋ 消耗品／維修工具／碎片
// （profile 上的整數欄位）。任何要顯示物品中文名、查持有量、發放或扣除的功能都走這裡，
// 避免各處各自複製一份名稱表而印出英文 id。
const { craft } = require("../../config");
const itemCatalog = require("../barter/itemCatalog");
const inventory = require("../barter/inventoryAdapter");

const CONSUMABLES = [
  { field: "cd_ticket_count", name: "🎫 CD 縮短券" },
  { field: "luck_potion_uses", name: "🍀 幸運藥水" },
  { field: "whetstone_inferior_count", name: "🪨 劣質磨石" },
  { field: "fishing_net_uses", name: "🕸️ 撈網" },
  { field: "advanced_trap_uses", name: "⚙️ 高級陷阱（必定抵擋）" },
  { field: "basic_trap_uses", name: "🪤 簡易陷阱（70% 抵擋）" },
  { field: "treasure_maps", name: "🗺️ 藏寶圖" },
  { field: "stamina_potion_count", name: "🥤 體力藥水（小）" },
  { field: "stamina_potion_medium_count", name: "🥤 體力藥水（中）" },
  { field: "stamina_potion_large_count", name: "🥤 體力藥水（大）" },
  { field: "hp_potion_small", name: "❤️ 生命藥水（小）" },
  { field: "hp_potion_medium", name: "❤️ 生命藥水（中）" },
  { field: "hp_potion_large", name: "❤️ 生命藥水（大）" },
];

// 碎片：profile 根層的複數欄位 → 名稱取自 craft.materials（單數 key）。
const FRAGMENTS = [
  { field: "legendary_fragments", mat: "legendary_fragment" },
  { field: "broken_net_fragments", mat: "broken_net_fragment" },
  { field: "broken_trap_fragments", mat: "broken_trap_fragment" },
  { field: "treasure_map_fragments", mat: "treasure_map_fragment" },
];

function listAll() {
  const items = [];
  for (const c of itemCatalog.listAll()) {
    items.push({ value: `bag:${c.value}`, name: c.name });
  }
  for (const it of CONSUMABLES) {
    items.push({ value: `inc:${it.field}`, name: it.name });
  }
  for (const [tier, def] of Object.entries(craft?.repairTools || {})) {
    if (!def?.name) continue;
    items.push({ value: `inc:repair_tools.${tier}`, name: `${def.emoji || "🔧"} ${def.name}` });
  }
  for (const f of FRAGMENTS) {
    const def = (craft?.materials || {})[f.mat];
    if (!def?.name) continue;
    items.push({ value: `inc:${f.field}`, name: `${def.emoji || "🧩"} ${def.name}` });
  }
  return items;
}

function resolve(value) {
  const entry = listAll().find((r) => r.value === value);
  if (!entry) return null;
  if (value.startsWith("bag:")) {
    const parsed = itemCatalog.parseChoice(value.slice("bag:".length));
    if (!parsed) return null;
    return { value, kind: "bag", type: parsed.type, key: parsed.key, label: entry.name };
  }
  return { value, kind: "inc", field: value.slice("inc:".length), label: entry.name };
}

// 找不到定義時回 null，呼叫端要顯示「（已下架物品）」而不是把 id 印出來。
function labelOf(value) {
  return resolve(value)?.label || null;
}

function readField(profile, field) {
  return field.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), profile) || 0;
}

function ownedQty(profile, value) {
  const item = resolve(value);
  if (!item || !profile) return 0;
  if (item.kind === "bag") return inventory.readQty(profile, item.type, item.key);
  return readField(profile, item.field);
}

// 玩家目前持有數 > 0 的所有物品，依 listAll 的順序（礦石→作物→魚→道具→碎片）。
function listOwned(profile) {
  return listAll()
    .map((entry) => ({ ...entry, qty: ownedQty(profile, entry.value) }))
    .filter((entry) => entry.qty > 0);
}

async function grant(client, userId, guildId, value, qty) {
  const item = resolve(value);
  if (!item || qty <= 0) return false;
  if (item.kind === "bag") {
    return inventory.add(client, userId, guildId, item.type, item.key, qty);
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { [item.field]: qty },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  );
  return true;
}

// 條件式扣除：持有量不足時不寫入並回 false（避免併發點兩次扣成負數）。
async function take(client, userId, guildId, value, qty) {
  const item = resolve(value);
  if (!item || qty <= 0) return false;
  const path = item.kind === "bag" ? bagPath(item) : item.field;
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, [path]: { $gte: qty } },
    { $inc: { [path]: -qty }, $set: { updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

function bagPath(item) {
  if (item.type === "ore") return `backpack.${item.key}`;
  if (item.type === "crop") return `veggie_bag.${item.key}`;
  return `fish_bag.${item.key}`;
}

module.exports = { listAll, resolve, labelOf, ownedQty, listOwned, grant, take };
