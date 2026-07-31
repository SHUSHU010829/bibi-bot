// 集中管理 MiningProfiles 的預設欄位與讀取，避免 schema 預設散落各處。
const { mining, fishing, farming, dungeon } = require("../../config");

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
    stamina_potion_medium_count: 0,
    stamina_potion_large_count: 0,
    cd_ticket_count: 0,
    cd_ticket_used_date: null,
    cd_ticket_used_count: 0,
    batch_pass_count: 0,
    batch_pass_expires_at: 0,
    backpack_bonus_slots: 0,
    mine_count_total: 0,
    craft_count_total: 0,
    backpack: { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0, compost: 0, monster_slime: 0, moonlight_dew: 0 },
    lifetime_ore: { stone: 0, coal: 0, iron: 0, gold: 0, diamond: 0 },
    seed_bag: { seed_carrot: 0, seed_corn: 0, seed_strawberry: 0, seed_black_rose: 0 },
    veggie_bag: { carrot: 0, corn: 0, strawberry: 0, black_rose: 0 },
    rare_bait: 0,
    broken_net_fragments: 0,
    fishing_net_uses: 0,
    broken_trap_fragments: 0,
    pioneer_hammer: false,
    deep_stamina: null,
    deep_stamina_updated_at: 0,
    deep_mine_count_total: 0,
    sealing_ammo_count: 0,
    sealing_ammo_week: "",
    advanced_trap_uses: 0,
    treasure_map_fragments: 0,
    treasure_maps: 0,
    neighbor_prank_count: 0,
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
    last_fish_location: "stream",
    fish_bag: { small_fish: 0, crucian: 0, shark: 0, octopus: 0, lava_fish: 0 },
    fishing_rod: "bamboo",
    rod_durability: null,
    rod_max_durability: null,
    active_food_buffs: [],
    food_bag: [],
    hp_max: dungeon?.hp?.baseMax ?? 100,
    hp_current: dungeon?.hp?.baseMax ?? 100,
    hp_updated_at: 0,
    def: 0,
    shield: null,
    shield_durability: null,
    shield_max_durability: null,
    hp_potion_small: 0,
    hp_potion_medium: 0,
    hp_potion_large: 0,
    floor_unlocks: {
      mine:  { max_floor: 1, clears: {}, mini_boss_claimed_clears: 0 },
      ruins: { max_floor: 0, clears: {}, mini_boss_claimed_clears: 0 },
      ice:   { max_floor: 0, clears: {}, mini_boss_claimed_clears: 0 },
    },
    mini_boss_kills: { mine: 0, ruins: 0, ice: 0 },
    mini_boss_encounter_seq: { mine: 0, ruins: 0, ice: 0 },
    dragon_slayer_kills: 0,
    dungeon_auto_potion: true,
    dungeon_auto_potion_tier: "smallest",
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
  doc.broken_net_fragments ??= 0;
  doc.fishing_net_uses ??= 0;
  doc.broken_trap_fragments ??= 0;
  doc.pioneer_hammer ??= false;
  doc.deep_stamina ??= null;
  doc.deep_stamina_updated_at ??= 0;
  doc.deep_mine_count_total ??= 0;
  doc.sealing_ammo_count ??= 0;
  doc.sealing_ammo_week ??= "";
  doc.advanced_trap_uses ??= 0;
  doc.treasure_map_fragments ??= 0;
  doc.treasure_maps ??= 0;
  doc.neighbor_prank_count ??= 0;
  doc.farm_plot_count ??= 2;
  doc.farm_count_total ??= 0;
  doc.farm_harvest_total ??= 0;
  doc.mine_cooldown_at ??= 0;
  doc.pickaxe ??= "wood";
  if (doc.pickaxe_durability === undefined) doc.pickaxe_durability = null;
  // 回填 pickaxe_max_durability：舊文件若持有非木鎬但缺此欄位，從設定補齊
  // 避免劣質磨石「補滿到 max=null」把鎬子變磚。
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
  doc.stamina_potion_medium_count ??= 0;
  doc.stamina_potion_large_count ??= 0;
  doc.cd_ticket_count ??= 0;
  if (doc.cd_ticket_used_date === undefined) doc.cd_ticket_used_date = null;
  doc.cd_ticket_used_count ??= 0;
  doc.batch_pass_count ??= 0;
  doc.batch_pass_expires_at ??= 0;
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
  if (!fishing?.locations?.[doc.last_fish_location]) doc.last_fish_location = "stream";
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

  // Phase H+ 地下城進階：HP / DEF / 盾 / 樓層解鎖
  const hpBase = dungeon?.hp?.baseMax ?? 100;
  if (typeof doc.hp_max !== "number") doc.hp_max = hpBase;
  if (typeof doc.hp_current !== "number") doc.hp_current = doc.hp_max;
  doc.hp_updated_at ??= 0;
  if (typeof doc.def !== "number") doc.def = 0;
  if (doc.shield === undefined) doc.shield = null;
  if (doc.shield_durability === undefined) doc.shield_durability = null;
  if (doc.shield_max_durability === undefined || doc.shield_max_durability === null) {
    if (doc.shield && typeof doc.shield_durability === "number") {
      const configMax = dungeon?.shields?.[doc.shield]?.durability ?? null;
      doc.shield_max_durability = configMax != null
        ? Math.max(doc.shield_durability, configMax)
        : null;
    } else {
      doc.shield_max_durability = null;
    }
  }
  doc.hp_potion_small ??= 0;
  doc.hp_potion_medium ??= 0;
  doc.hp_potion_large ??= 0;
  doc.floor_unlocks = {
    mine:  { max_floor: 1, clears: {}, mini_boss_claimed_clears: 0, ...(doc.floor_unlocks?.mine || {}) },
    ruins: { max_floor: 0, clears: {}, mini_boss_claimed_clears: 0, ...(doc.floor_unlocks?.ruins || {}) },
    ice:   { max_floor: 0, clears: {}, mini_boss_claimed_clears: 0, ...(doc.floor_unlocks?.ice || {}) },
  };
  for (const theme of ["mine", "ruins", "ice"]) {
    if (!doc.floor_unlocks[theme].clears || typeof doc.floor_unlocks[theme].clears !== "object") {
      doc.floor_unlocks[theme].clears = {};
    }
  }
  doc.mini_boss_kills = { mine: 0, ruins: 0, ice: 0, ...(doc.mini_boss_kills || {}) };
  doc.mini_boss_encounter_seq = { mine: 0, ruins: 0, ice: 0, ...(doc.mini_boss_encounter_seq || {}) };
  doc.dragon_slayer_kills ??= 0;

  // Phase H+ 自動藥水偏好：開關 + 用哪瓶優先
  if (typeof doc.dungeon_auto_potion !== "boolean") doc.dungeon_auto_potion = true;
  const VALID_TIERS = ["smallest", "largest", "small", "medium", "large"];
  if (!VALID_TIERS.includes(doc.dungeon_auto_potion_tier)) {
    doc.dungeon_auto_potion_tier = "smallest";
  }

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
const ORE_KEYS = ["stone", "coal", "iron", "gold", "diamond", "magic_crystal"];
function backpackUsed(profile) {
  const bp = profile?.backpack || {};
  return ORE_KEYS.reduce((sum, k) => sum + (bp[k] || 0), 0);
}

// 魚袋容量（基礎 + 擴充）。只計魚，非魚漁獲不入袋故不占容量。
// 擴充共用 backpack_bonus_slots：「背包擴充」道具一次同步擴三袋，故三袋加成永遠相等。
const FISH_KEYS = ["small_fish", "crucian", "shark", "octopus", "lava_fish"];
function fishBagCapacity(profile, fishingCfg = fishing) {
  const base = fishingCfg?.fishBagBaseSlots ?? 100;
  return base + (profile?.backpack_bonus_slots || 0);
}
function fishBagUsed(profile) {
  const bag = profile?.fish_bag || {};
  return FISH_KEYS.reduce((sum, k) => sum + (bag[k] || 0), 0);
}

// 菜籃容量（基礎 + 擴充）。只計收成作物，種子與肥料不占容量。共用 backpack_bonus_slots（同上）。
const VEGGIE_KEYS = ["carrot", "corn", "strawberry", "black_rose"];
function veggieBagCapacity(profile, farmingCfg = farming) {
  const base = farmingCfg?.veggieBagBaseSlots ?? 100;
  return base + (profile?.backpack_bonus_slots || 0);
}
function veggieBagUsed(profile) {
  const bag = profile?.veggie_bag || {};
  return VEGGIE_KEYS.reduce((sum, k) => sum + (bag[k] || 0), 0);
}

// 連續通行證：付費啟用後於 expires_at 前無視挖礦／釣魚的批次解鎖等級門檻。
// 挖礦與釣魚共用同一份 MiningProfiles 文件與同一個到期時間，用時即時判定。
function isBatchPassActive(profile) {
  return (profile?.batch_pass_expires_at || 0) > Date.now();
}

module.exports = {
  defaultProfile,
  normalize,
  isBatchPassActive,
  getOrCreate,
  backpackCapacity,
  backpackUsed,
  ORE_KEYS,
  fishBagCapacity,
  fishBagUsed,
  FISH_KEYS,
  veggieBagCapacity,
  veggieBagUsed,
  VEGGIE_KEYS,
};
