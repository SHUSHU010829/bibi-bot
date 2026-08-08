// 全站唯一的「可轉移物品」名稱表。涵蓋玩家背包裡每一種可堆疊物品：
//   bag:  礦石／作物／魚（miningProfile 的三個 map）
//   inc:  種子／肥料／消耗道具／維修工具／碎片素材（profile 上的整數欄位，支援巢狀路徑）
//   food: 食物倉庫（food_bag 陣列，每份帶烹飪時間與新鮮度）
// 任何要顯示物品中文名、查持有量、發放或扣除的功能都走這裡，
// 避免各處各自複製一份名稱表而印出英文 id。
const { craft, mining, farming, fishing } = require("../../config");
const itemCatalog = require("../barter/itemCatalog");
const inventory = require("../barter/inventoryAdapter");
const foodBag = require("../fishing/foodBag");

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

// 素材：名稱取自 craft.materials（單數 key），持有量存在 profile 的另一個欄位／路徑。
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

function foodEntries() {
  return Object.entries(fishing?.recipes || {}).map(([recipeId, def]) => ({
    recipeId,
    name: `${def.emoji || "🍱"} ${def.name}（食物）`,
  }));
}

function listAll() {
  const items = [];
  for (const c of itemCatalog.listAll()) {
    items.push({ value: `bag:${c.value}`, name: c.name });
  }
  for (const it of seedEntries()) {
    items.push({ value: `inc:${it.field}`, name: it.name });
  }
  for (const it of fertilizerEntries()) {
    items.push({ value: `inc:${it.field}`, name: it.name });
  }
  for (const it of CONSUMABLES) {
    items.push({ value: `inc:${it.field}`, name: it.name });
  }
  for (const [tier, def] of Object.entries(craft?.repairTools || {})) {
    if (!def?.name) continue;
    items.push({ value: `inc:repair_tools.${tier}`, name: `${def.emoji || "🔧"} ${def.name}` });
  }
  for (const m of MATERIALS) {
    const def = (craft?.materials || {})[m.mat];
    if (!def?.name) continue;
    items.push({ value: `inc:${m.field}`, name: `${m.emoji || def.emoji || "🧩"} ${def.name}` });
  }
  for (const it of foodEntries()) {
    items.push({ value: `food:${it.recipeId}`, name: it.name });
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
    return { value, kind: "bag", type: parsed.type, key: parsed.key, label: entry.name };
  }
  if (value.startsWith("food:")) {
    return { value, kind: "food", recipeId: value.slice("food:".length), label: entry.name };
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
  if (item.kind === "food") {
    return foodBag.listFresh(profile).filter((it) => it.recipeId === item.recipeId).length;
  }
  return readField(profile, item.field);
}

// 玩家目前持有數 > 0 的所有物品，依 listAll 的順序（礦石→作物→魚→種子→肥料→道具→素材→食物）。
function listOwned(profile) {
  return listAll()
    .map((entry) => ({ ...entry, qty: ownedQty(profile, entry.value) }))
    .filter((entry) => entry.qty > 0);
}

function incPath(item) {
  if (item.kind === "bag") return bagPath(item);
  return item.field;
}

async function grant(client, userId, guildId, value, qty) {
  const item = resolve(value);
  if (!item || qty <= 0) return false;
  if (item.kind === "bag") {
    return inventory.add(client, userId, guildId, item.type, item.key, qty);
  }
  if (item.kind === "food") {
    const now = Date.now();
    return grantFood(
      client,
      userId,
      guildId,
      Array.from({ length: qty }, () => ({ recipeId: item.recipeId, cookedAt: now, useCoal: false })),
    );
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
// 食物走 takeFood（要挑實際的份數 instance），這裡只回成功與否。
async function take(client, userId, guildId, value, qty) {
  const item = resolve(value);
  if (!item || qty <= 0) return false;
  if (item.kind === "food") return (await takeFood(client, userId, guildId, value, qty)).ok;
  const path = incPath(item);
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, [path]: { $gte: qty } },
    { $inc: { [path]: -qty }, $set: { updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

// 食物是「一份一個 instance」（各自有烹飪時間與新鮮度），扣除時要把實際被拿走的份數回傳，
// 這樣託管退回時才能把同樣的新鮮度還回去，而不是變成剛出爐的新品。
// 先拿最舊的（跟食物倉庫「先吃快壞的」同一個順序）。
async function takeFood(client, userId, guildId, value, qty) {
  const item = resolve(value);
  if (!item || item.kind !== "food" || qty <= 0) return { ok: false, instances: [] };

  const profile = await client.miningProfilesCollection.findOne({ userId, guildId });
  const fresh = foodBag
    .listFresh(profile)
    .filter((it) => it.recipeId === item.recipeId)
    .sort((a, b) => a.freshness - b.freshness);
  if (fresh.length < qty) return { ok: false, instances: [] };

  const picked = fresh.slice(0, qty);
  const ids = picked.map((it) => it.id);
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, "food_bag.id": { $all: ids } },
    { $pull: { food_bag: { id: { $in: ids } } }, $set: { updatedAt: new Date() } },
  );
  if (res.matchedCount === 0) return { ok: false, instances: [] };
  return {
    ok: true,
    instances: picked.map((it) => ({
      recipeId: it.recipeId,
      cookedAt: it.cookedAt,
      useCoal: !!it.useCoal,
    })),
  };
}

// 把食物 instance 寫進倉庫。id 一律重發，避免跟對方倉庫既有的 id 撞號；
// cookedAt 沿用原值，新鮮度才會接續衰減而不是重新計算。
async function grantFood(client, userId, guildId, instances) {
  const list = (instances || []).filter((it) => it?.recipeId);
  if (list.length === 0) return false;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $push: {
        food_bag: {
          $each: list.map((it) => ({
            id: foodBag.newId(),
            recipeId: it.recipeId,
            cookedAt: it.cookedAt || Date.now(),
            useCoal: !!it.useCoal,
          })),
        },
      },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  );
  return true;
}

function bagPath(item) {
  if (item.type === "ore") return `backpack.${item.key}`;
  if (item.type === "crop") return `veggie_bag.${item.key}`;
  return `fish_bag.${item.key}`;
}

module.exports = {
  listAll,
  bagValue,
  resolve,
  labelOf,
  ownedQty,
  listOwned,
  grant,
  take,
  takeFood,
  grantFood,
};
