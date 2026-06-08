// 集中管理 MiningProfiles 的預設欄位與讀取，避免 schema 預設散落各處。
const { mining, fishing, dungeon } = require("../../config");

function defaultProfile(userId, guildId) {
  return {
    userId,
    guildId,
    mine_cooldown_at: 0,
    pickaxe: "wood",
    pickaxe_durability: null,
    pickaxe_max_durability: null,
    weapon: "fist",
    weapon_durability: null,
    weapon_max_durability: null,
    luck_potion_uses: 0,
    whetstone_inferior_count: 0,
    repair_tools: { iron: 0, steel: 0, gold: 0, mythril: 0, diamond: 0, legendary: 0 },
    stamina_potion_count: 0,
    cd_ticket_count: 0,
    cd_ticket_used_date: null,
    cd_ticket_used_count: 0,
    backpack_bonus_slots: 0,
    mine_count_total: 0,
    craft_count_total: 0,
    backpack: { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0, compost: 0, monster_slime: 0, moonlight_dew: 0 },
    lifetime_ore: { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0 },
    seed_bag: { seed_carrot: 0, seed_corn: 0, seed_strawberry: 0, seed_black_rose: 0 },
    veggie_bag: { carrot: 0, corn: 0, strawberry: 0, black_rose: 0 },
    rare_bait: 0,
    farm_plot_count: 2,
    farm_count_total: 0,
    farm_harvest_total: 0,
    weekly_champion_count: 0,
    stamina: null,
    stamina_updated_at: 0,
    dungeon_count: 0,
    legendary_fragments: 0,
    pending_appraisal: null,
    gift_date: null,
    gift_count: 0,
    fish_cooldown_at: 0,
    fish_count_total: 0,
    fish_bag: { small_fish: 0, crucian: 0, shark: 0, octopus: 0, lava_fish: 0 },
    fishing_rod: "bamboo",
    rod_durability: null,
    rod_max_durability: null,
    active_food_buffs: [],
    food_bag: [],
    createdAt: new Date(),
  };
}

// 補齊舊文件可能缺少的欄位（例如先前只由商店購買 upsert 出來的 doc）。
function normalize(doc) {
  if (!doc) return doc;
  doc.backpack = { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0, compost: 0, monster_slime: 0, moonlight_dew: 0, ...(doc.backpack || {}) };
  doc.lifetime_ore = { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0, ...(doc.lifetime_ore || {}) };
  doc.seed_bag = { seed_carrot: 0, seed_corn: 0, seed_strawberry: 0, seed_black_rose: 0, ...(doc.seed_bag || {}) };
  doc.veggie_bag = { carrot: 0, corn: 0, strawberry: 0, black_rose: 0, ...(doc.veggie_bag || {}) };
  doc.rare_bait ??= 0;
  doc.farm_plot_count ??= 2;
  doc.farm_count_total ??= 0;
  doc.farm_harvest_total ??= 0;
  doc.mine_cooldown_at ??= 0;
  doc.pickaxe ??= "wood";
  if (doc.pickaxe_durability === undefined) doc.pickaxe_durability = null;
  // 回填 pickaxe_max_durability：舊文件若持有非木鎬但缺此欄位，從設定補齊
  // 避免劣質磨鎬石「補滿到 max=null」把鎬子變磚。
  if (doc.pickaxe_max_durability === undefined || doc.pickaxe_max_durability === null) {
    if (doc.pickaxe && doc.pickaxe !== "wood" && typeof doc.pickaxe_durability === "number") {
      const configMax = mining?.pickaxes?.[doc.pickaxe]?.durability ?? null;
      doc.pickaxe_max_durability = configMax != null
        ? Math.max(doc.pickaxe_durability, configMax)
        : null;
    } else {
      doc.pickaxe_max_durability = null;
    }
  }
  doc.weapon ??= "fist";
  if (doc.weapon_durability === undefined) doc.weapon_durability = null;
  // 回填 weapon_max_durability：舊文件若持有非 fist 但缺此欄位，從設定補齊（比照鎬子）
  if (doc.weapon_max_durability === undefined || doc.weapon_max_durability === null) {
    if (doc.weapon && doc.weapon !== "fist" && typeof doc.weapon_durability === "number") {
      const configMax = dungeon?.weapons?.[doc.weapon]?.durability ?? null;
      doc.weapon_max_durability = configMax != null
        ? Math.max(doc.weapon_durability, configMax)
        : null;
    } else {
      doc.weapon_max_durability = null;
    }
  }
  doc.luck_potion_uses ??= 0;
  doc.whetstone_inferior_count ??= 0;
  doc.repair_tools = { iron: 0, steel: 0, gold: 0, mythril: 0, diamond: 0, legendary: 0, ...(doc.repair_tools || {}) };
  doc.stamina_potion_count ??= 0;
  doc.cd_ticket_count ??= 0;
  if (doc.cd_ticket_used_date === undefined) doc.cd_ticket_used_date = null;
  doc.cd_ticket_used_count ??= 0;
  doc.backpack_bonus_slots ??= 0;
  doc.mine_count_total ??= 0;
  doc.craft_count_total ??= 0;
  doc.weekly_champion_count ??= 0;
  if (doc.stamina === undefined) doc.stamina = null;
  doc.stamina_updated_at ??= 0;
  doc.dungeon_count ??= 0;
  doc.legendary_fragments ??= 0;
  if (doc.pending_appraisal === undefined) doc.pending_appraisal = null;
  if (doc.gift_date === undefined) doc.gift_date = null;
  doc.gift_count ??= 0;
  doc.fish_cooldown_at ??= 0;
  doc.fish_count_total ??= 0;
  doc.fish_bag = { small_fish: 0, crucian: 0, shark: 0, octopus: 0, lava_fish: 0, ...(doc.fish_bag || {}) };
  doc.fishing_rod ??= "bamboo";
  if (doc.rod_durability === undefined) doc.rod_durability = null;
  // 回填 rod_max_durability：舊文件若持有非竹竿但缺此欄位，從設定補齊（比照鎬子）
  if (doc.rod_max_durability === undefined || doc.rod_max_durability === null) {
    if (doc.fishing_rod && doc.fishing_rod !== "bamboo" && typeof doc.rod_durability === "number") {
      const configMax = fishing?.rods?.[doc.fishing_rod]?.durability ?? null;
      doc.rod_max_durability = configMax != null
        ? Math.max(doc.rod_durability, configMax)
        : null;
    } else {
      doc.rod_max_durability = null;
    }
  }
  if (!Array.isArray(doc.active_food_buffs)) doc.active_food_buffs = [];
  if (!Array.isArray(doc.food_bag)) doc.food_bag = [];
  return doc;
}

async function getOrCreate(client, userId, guildId) {
  const now = new Date();
  const res = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId },
    {
      $setOnInsert: defaultProfile(userId, guildId),
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" }
  );
  return normalize(res.value || res);
}

// 背包總容量（基礎 + 擴充）
function backpackCapacity(profile, mining) {
  const base = mining?.backpackBaseSlots ?? 100;
  return base + (profile?.backpack_bonus_slots || 0);
}

// 背包目前使用量（只計礦石，肥料類道具不占容量）
const ORE_KEYS = ["stone", "coal", "iron", "gold", "diamond"];
function backpackUsed(profile) {
  const bp = profile?.backpack || {};
  return ORE_KEYS.reduce((sum, k) => sum + (bp[k] || 0), 0);
}

module.exports = {
  defaultProfile,
  normalize,
  getOrCreate,
  backpackCapacity,
  backpackUsed,
};
