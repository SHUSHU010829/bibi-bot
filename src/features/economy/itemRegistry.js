// 全站唯一的「可轉移物品」名稱表。涵蓋玩家背包裡的可堆疊物品：
//   bag: 礦石／作物／魚（miningProfile 的三個 map）
//   inc: 種子／肥料／消耗道具／維修工具／素材（profile 上的整數欄位，支援巢狀路徑）
// 任何要顯示物品中文名、查持有量、發放或扣除的功能都走這裡，
// 避免各處各自複製一份名稱表而印出英文 id。
//
// category 供呼叫端篩選用途（例：/贈送 只開放材料類，見 gift.json 的 itemCategories）。
const { craft, mining, farming } = require("../../config");
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
  { field: "rare_bait", name: "🎏 稀有魚餌" },
  { field: "batch_pass_count", name: "🎟️ 連續通行證" },
];

// 合成素材：名稱取自 craft.materials（單數 key），持有量存在 profile 的另一個欄位／路徑。
// emoji 用來覆寫 config 裡的自訂 emoji（<:x:id> 在 autocomplete 選單只會顯示成原始字串）。
const MATERIALS = [
  { field: "legendary_fragments", mat: "legendary_fragment" },
  { field: "broken_net_fragments", mat: "broken_net_fragment" },
  { field: "broken_trap_fragments", mat: "broken_trap_fragment" },
  { field: "treasure_map_fragments", mat: "treasure_map_fragment" },
  { field: "sealing_ammo_count", mat: "sealing_ammo" },
  { field: "backpack.stone_shard", mat: "stone_shard", emoji: "🪨" },
];

// 種子：每種作物一款，欄位固定在 seed_bag（與 miningProfile 的 schema 對齊）。
function seedEntries() {
  return Object.entries(farming?.crops || {}).map(([cropKey, def]) => ({
    field: `seed_bag.seed_${cropKey}`,
    name: `🌱 ${def.name}種子`,
  }));
}

// 肥料：只收 source=backpack 的，且排除本身就是礦石的（煤炭灰用的是煤炭，已列在礦石）。
function fertilizerEntries() {
  return Object.values(farming?.fertilizers || {})
    .filter((f) => f.source === "backpack" && f.key && !mining?.ores?.[f.key])
    .map((f) => ({
      field: `backpack.${f.key}`,
      name: `${f.emoji || "💧"} ${f.name}`,
    }));
}

// itemCatalog 的 value 是 <type>:<key>，type 同時就是分類（ore / crop / fish）。
function bagCategory(value) {
  return value.split(":")[0];
}

function listAll() {
  const items = [];
  for (const c of itemCatalog.listAll()) {
    items.push({ value: `bag:${c.value}`, name: c.name, category: bagCategory(c.value) });
  }
  for (const it of seedEntries()) {
    items.push({ value: `inc:${it.field}`, name: it.name, category: "seed" });
  }
  for (const it of fertilizerEntries()) {
    items.push({ value: `inc:${it.field}`, name: it.name, category: "fertilizer" });
  }
  for (const it of CONSUMABLES) {
    items.push({ value: `inc:${it.field}`, name: it.name, category: "consumable" });
  }
  for (const [tier, def] of Object.entries(craft?.repairTools || {})) {
    if (!def?.name) continue;
    items.push({
      value: `inc:repair_tools.${tier}`,
      name: `${def.emoji || "🔧"} ${def.name}`,
      category: "repair_tool",
    });
  }
  for (const m of MATERIALS) {
    const def = (craft?.materials || {})[m.mat];
    if (!def?.name) continue;
    items.push({
      value: `inc:${m.field}`,
      name: `${m.emoji || def.emoji || "🧩"} ${def.name}`,
      category: "material",
    });
  }
  return items;
}

// 舊資料（贈送 offer 早期只存 type/key）→ 現行 registry value。
function bagValue(type, key) {
  return `bag:${type}:${key}`;
}

function resolve(value) {
  const entry = listAll().find((r) => r.value === value);
  if (!entry) return null;
  if (value.startsWith("bag:")) {
    const parsed = itemCatalog.parseChoice(value.slice("bag:".length));
    if (!parsed) return null;
    return {
      value,
      kind: "bag",
      type: parsed.type,
      key: parsed.key,
      label: entry.name,
      category: entry.category,
    };
  }
  return {
    value,
    kind: "inc",
    field: value.slice("inc:".length),
    label: entry.name,
    category: entry.category,
  };
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

// 玩家目前持有數 > 0 的所有物品，依 listAll 的順序（礦石→作物→魚→種子→肥料→道具→素材）。
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

module.exports = { listAll, bagValue, resolve, labelOf, ownedQty, listOwned, grant, take };
