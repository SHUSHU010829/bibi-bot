require("colors");
const { mining, craft, dungeon, fishing } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
  ORE_KEYS,
} = require("./miningProfile");
const { SPECIAL_MAT_FIELDS, isFishMaterial, ownedMaterial } = require("./craftMaterials");
const { trapTier, totalTrapUses } = require("../farm/trapTiers");

// 鎬子 / 武器 / 釣竿階級（用於判定升級 / 同級 / 降級）
const PICKAXE_TIER = { wood: 0, iron: 1, gold: 2, diamond: 3, magic: 4 };
const WEAPON_TIER = {
  fist: 0,
  iron_sword: 1,
  steel_sword: 2,
  gold_sword: 3,
  diamond_sword: 4,
  legendary_sword: 5,
  magic_sword: 6,
};
const ROD_TIER = { bamboo: 0, carbon: 1, gold: 2, mythril: 3, magic: 4 };
// Phase H+ 盾牌階級（v1：鐵盾 / 鋼盾；v2：黃金 / 鑽石 / 傳說）
const SHIELD_TIER = {
  iron_shield: 1,
  steel_shield: 2,
  gold_shield: 3,
  diamond_shield: 4,
  legendary_shield: 5,
  magic_shield: 6,
};

// 傳說碎片 key（對外保留）
const FRAGMENT_KEY = "legendary_fragment";

function getRecipe(recipeId) {
  return (craft?.recipes || []).find((r) => r.id === recipeId) || null;
}

// 依手上材料算這個配方最多能合成幾次（取各材料 floor(have/need) 的最小值）。
function maxCraftTimes(profile, recipe) {
  let times = Infinity;
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    if (need <= 0) continue;
    times = Math.min(times, Math.floor(ownedMaterial(profile, mat) / need));
  }
  return Number.isFinite(times) ? Math.max(0, times) : 0;
}

// 依裝備類型回傳該裝備的定義表與玩家身上的對應欄位名稱。
function resolveSlot(type) {
  if (type === "weapon") {
    return {
      defs: dungeon?.weapons || {},
      tiers: WEAPON_TIER,
      equippedField: "weapon",
      durabilityField: "weapon_durability",
      maxDurabilityField: "weapon_max_durability",
      defaultId: "fist",
    };
  }
  if (type === "rod") {
    return {
      defs: fishing?.rods || {},
      tiers: ROD_TIER,
      equippedField: "fishing_rod",
      durabilityField: "rod_durability",
      maxDurabilityField: "rod_max_durability",
      defaultId: "bamboo",
    };
  }
  if (type === "shield") {
    return {
      defs: dungeon?.shields || {},
      tiers: SHIELD_TIER,
      equippedField: "shield",
      durabilityField: "shield_durability",
      maxDurabilityField: "shield_max_durability",
      defaultId: null, // 沒裝盾代表赤手 — defaultId 為 null
    };
  }
  // 預設視為鎬子
  return {
    defs: mining?.pickaxes || {},
    tiers: PICKAXE_TIER,
    equippedField: "pickaxe",
    durabilityField: "pickaxe_durability",
    maxDurabilityField: "pickaxe_max_durability",
    defaultId: "wood",
  };
}

// 合成裝備（鎬子 / 武器）。confirm=true 時略過「替換仍可用裝備」的二次確認。
async function craftItem(client, { userId, guildId, recipeId, confirm = false, craftAll = false }) {
  if (!mining?.enabled || !craft?.recipes) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, reason: "no_recipe" };

  const type = recipe.result?.type || "pickaxe";
  const resultId = recipe.result?.id;

  // 維修工具：消耗品，不走 equipment slot 替換流程
  if (type === "repair_tool") {
    return craftRepairTool(client, { userId, guildId, recipe, tier: resultId });
  }

  // 撈網：消耗 broken_net_fragment，累加 fishing_net_uses
  if (type === "fishing_net") {
    return craftFishingNet(client, { userId, guildId, recipe });
  }

  // 賭石碎石：消耗碎石，設定 pending_appraisal（synthetic）等玩家點「立刻賭石」
  if (type === "stone_appraisal_trigger") {
    return craftStoneAppraisalTrigger(client, {
      userId, guildId, recipe,
      quality: recipe.result?.quality === "high" ? "high" : "low",
      craftAll,
    });
  }

  // 高級陷阱：自動使用，累加 advanced_trap_uses（上限 12）
  if (type === "advanced_trap") {
    return craftAdvancedTrap(client, { userId, guildId, recipe });
  }

  // 藏寶圖：累加 treasure_maps（無上限，到 /背包 探險道具區按使用觸發）
  if (type === "treasure_map") {
    return craftTreasureMap(client, { userId, guildId, recipe });
  }

  // 礦石回收：把素材熔回礦石（例：破損陷阱碎片 → 鐵礦）
  if (type === "ore") {
    return craftOre(client, { userId, guildId, recipe });
  }

  // 封魔彈藥：週六魔王戰專用消耗品，每週限做 1 個
  if (type === "sealing_ammo") {
    return craftSealingAmmo(client, { userId, guildId, recipe });
  }

  // 拓荒錘：主線活動的參與門檻，非消耗品，持有一把即可
  if (type === "pioneer_hammer") {
    return craftPioneerHammer(client, { userId, guildId, recipe });
  }

  const slot = resolveSlot(type);
  const targetDef = slot.defs[resultId];
  if (!targetDef) return { ok: false, reason: "no_recipe" };

  const profile = await getOrCreate(client, userId, guildId);

  // 升級型配方：材料較省，但必須正在裝備指定的前一階裝備（會被覆蓋掉）
  const needEquipped = recipe.requires?.equipped;
  if (needEquipped && (profile[slot.equippedField] || slot.defaultId) !== needEquipped) {
    return {
      ok: false,
      reason: "requires_equipped",
      recipe,
      type,
      needEquipped,
      needEquippedName: slot.defs[needEquipped]?.name || needEquipped,
      currentName: slot.defs[profile[slot.equippedField]]?.name || "（未裝備）",
    };
  }

  // 材料檢查
  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  // 替換確認：目前裝備非預設且仍有耐久時，無論升級 / 同級 / 降級都先要求確認
  const curId = profile[slot.equippedField] || slot.defaultId;
  const curDurability = profile[slot.durabilityField];
  const curTier = slot.tiers[curId] ?? 0;
  const newTier = slot.tiers[resultId] ?? 0;
  const hasUsable =
    curId !== slot.defaultId &&
    typeof curDurability === "number" &&
    curDurability > 0;
  if (!confirm && hasUsable) {
    let relation = "same";
    if (newTier > curTier) relation = "upgrade";
    else if (newTier < curTier) relation = "downgrade";
    return {
      ok: false,
      reason: "confirm_needed",
      recipe,
      type,
      current: { id: curId, durability: curDurability },
      relation,
    };
  }

  // 扣材料（傳說碎片走獨立欄位、魚走 fish_bag）+ 換裝備 + craft_count_total
  const inc = { craft_count_total: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  // 儲存的最大耐久一律是「原始上限」（config durability）；公會鐵匠鋪加成不寫死進 DB，
  // 由讀取端動態換算。新裝備現值直接補到「有效上限」，讓剛打造的裝備吃滿當前加成。
  const baseDurability = targetDef.durability ?? null;
  let currentDurability = baseDurability;
  if (typeof baseDurability === "number") {
    const buildingService = require("../guild_club/buildingService");
    const pct = await buildingService.getEquipmentMaxDurabilityPct(client, userId, guildId);
    currentDurability = buildingService.effectiveMaxDurability(baseDurability, pct);
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        [slot.equippedField]: resultId,
        [slot.durabilityField]: currentDurability,
        // 鎬子 / 釣竿 / 武器同步設定原始最大耐久上限
        ...(slot.maxDurabilityField ? { [slot.maxDurabilityField]: baseDurability } : {}),
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    recipe,
    type,
    resultId,
    resultName: targetDef.name || resultId,
    resultEmoji: targetDef.emoji || "",
    durability: currentDurability,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

async function craftRepairTool(client, { userId, guildId, recipe, tier }) {
  const profile = await getOrCreate(client, userId, guildId);

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const inc = { craft_count_total: 1, [`repair_tools.${tier}`]: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  const toolDef = (craft.repairTools || {})[tier] || {};
  return {
    ok: true,
    recipe,
    type: "repair_tool",
    resultId: tier,
    resultName: toolDef.name || recipe.name,
    resultEmoji: toolDef.emoji || recipe.emoji || "🔧",
    durability: null,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

async function craftFishingNet(client, { userId, guildId, recipe }) {
  const profile = await getOrCreate(client, userId, guildId);

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const cfg = craft?.fishingNet || {};
  const usesPerCraft = cfg.usesPerCraft ?? 3;

  const inc = {
    craft_count_total: 1,
    fishing_net_uses: usesPerCraft,
  };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  return {
    ok: true,
    recipe,
    type: "fishing_net",
    resultId: "fishing_net",
    resultName: recipe.name,
    resultEmoji: recipe.emoji || "🕸️",
    durability: null,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
    usesAdded: usesPerCraft,
    usesTotal: (profile.fishing_net_uses || 0) + usesPerCraft,
  };
}

async function craftStoneAppraisalTrigger(client, { userId, guildId, recipe, quality, craftAll = false }) {
  const profile = await getOrCreate(client, userId, guildId);

  // craftAll：把現有材料一次換成多顆，最多 maxBatch 顆；否則合成 1 顆。
  const cap = Math.max(1, mining?.stoneAppraisal?.maxBatch || 50);
  let times = 1;
  if (craftAll) {
    times = Math.min(maxCraftTimes(profile, recipe), cap);
    if (times < 1) times = 1; // 材料不足時 fall through 到下方 insufficient
  }

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const totalNeed = need * times;
    const have = ownedMaterial(profile, mat);
    if (have < totalNeed) missing.push({ mat, need: totalNeed, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const ts = Date.now();
  const inc = { craft_count_total: times };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    const totalNeed = need * times;
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - totalNeed;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - totalNeed;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - totalNeed;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        pending_appraisal: { qty: times, ts, quality, synthetic: true },
        updatedAt: new Date(),
      },
    },
  );

  return {
    ok: true,
    recipe,
    type: "stone_appraisal_trigger",
    resultId: quality,
    resultName: recipe.name,
    resultEmoji: recipe.emoji || (quality === "high" ? "💎" : "🪨"),
    quality,
    appraiseTs: ts,
    appraiseQty: times,
    craftCountTotal: (profile.craft_count_total || 0) + times,
  };
}

async function craftAdvancedTrap(client, { userId, guildId, recipe }) {
  const profile = await getOrCreate(client, userId, guildId);

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const cfg = craft?.advancedTrap || {};
  const tier = trapTier(recipe.result?.tier);
  const blocksPerCraft = tier.blocksPerCraft ?? cfg.blocksPerCraft ?? 4;
  const maxStack = cfg.maxStack ?? 12;

  // 上限是兩階共用的總次數，否則兩種各囤 12 次等於保護翻倍
  const current = totalTrapUses(profile);
  if (current >= maxStack) {
    return { ok: false, reason: "trap_full", current, maxStack, recipe };
  }
  const room = maxStack - current;
  const actualAdd = Math.min(blocksPerCraft, room);

  const inc = {
    craft_count_total: 1,
    [tier.field]: actualAdd,
  };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  return {
    ok: true,
    recipe,
    type: "advanced_trap",
    resultId: tier.id,
    resultName: recipe.name,
    resultEmoji: recipe.emoji || tier.emoji || "🪤",
    durability: null,
    blocksAdded: actualAdd,
    blocksAfter: current + actualAdd,
    blockChancePct: Math.round((tier.blockChance ?? 1) * 100),
    tierName: tier.name,
    maxStack,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

async function craftTreasureMap(client, { userId, guildId, recipe }) {
  const profile = await getOrCreate(client, userId, guildId);

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const inc = { craft_count_total: 1, treasure_maps: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  return {
    ok: true,
    recipe,
    type: "treasure_map",
    resultId: "treasure_map",
    resultName: recipe.name,
    resultEmoji: recipe.emoji || "🗺️",
    durability: null,
    mapsAfter: (profile.treasure_maps || 0) + 1,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

async function craftOre(client, { userId, guildId, recipe }) {
  const profile = await getOrCreate(client, userId, guildId);

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  const oreKey = recipe.result?.id;
  const qty = recipe.result?.qty ?? 1;

  // 產出礦石佔背包格。材料若本身也是礦石要扣回來，才是真正的淨增量。
  let delta = qty;
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    if (ORE_KEYS.includes(mat)) delta -= need;
  }
  const capacity = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (delta > 0 && used + delta > capacity) {
    return { ok: false, reason: "backpack_full", capacity, used, need: delta, recipe };
  }

  const inc = { craft_count_total: 1, [`backpack.${oreKey}`]: qty };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      const field = SPECIAL_MAT_FIELDS[mat];
      inc[field] = (inc[field] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  const oreDef = mining?.ores?.[oreKey] || {};
  return {
    ok: true,
    recipe,
    type: "ore",
    resultId: oreKey,
    resultName: recipe.name,
    resultEmoji: recipe.emoji || "🔥",
    durability: null,
    oreQty: qty,
    oreName: oreDef.name || oreKey,
    oreEmoji: oreDef.emoji || "",
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

// 週鍵（台北時區、週一為週首）。封魔彈藥每週限做 1 個。
function weekKeyTaipei() {
  const { DateTime } = require("luxon");
  const t = DateTime.now().setZone("Asia/Taipei");
  return `${t.weekYear}-W${String(t.weekNumber).padStart(2, "0")}`;
}

async function craftSealingAmmo(client, { userId, guildId, recipe }) {
  const { boss } = require("../../config");
  const acfg = boss?.sealingAmmo || {};
  const profile = await getOrCreate(client, userId, guildId);

  const week = weekKeyTaipei();
  const limit = acfg.weeklyCraftLimit ?? 1;
  if (profile.sealing_ammo_week === week && limit > 0) {
    return { ok: false, reason: "weekly_limit", limit, recipe };
  }

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) return { ok: false, reason: "insufficient", missing, recipe };

  // 逼幣走條件式原子扣款，餘額不足就整筆不動
  const coinCost = acfg.coinCost || 0;
  if (coinCost > 0) {
    const dec = await client.userCoinsCollection.updateOne(
      { userId, guildId, totalCoins: { $gte: coinCost } },
      { $inc: { totalCoins: -coinCost, lifetimeSpent: coinCost }, $set: { updatedAt: new Date() } },
    );
    if (dec.modifiedCount === 0) {
      const doc = await client.userCoinsCollection.findOne({ userId, guildId }).catch(() => null);
      return { ok: false, reason: "insufficient_coins", need: coinCost, have: doc?.totalCoins || 0, recipe };
    }
  }

  const inc = { craft_count_total: 1, sealing_ammo_count: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) inc[SPECIAL_MAT_FIELDS[mat]] = (inc[SPECIAL_MAT_FIELDS[mat]] || 0) - need;
    else if (isFishMaterial(mat)) inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    else inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
  }
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, sealing_ammo_week: { $ne: week } },
    { $inc: inc, $set: { sealing_ammo_week: week, updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) {
    if (coinCost > 0) {
      await client.userCoinsCollection.updateOne(
        { userId, guildId },
        { $inc: { totalCoins: coinCost, lifetimeSpent: -coinCost } },
      ).catch(() => {});
    }
    return { ok: false, reason: "weekly_limit", limit, recipe };
  }

  return {
    ok: true,
    recipe,
    type: "sealing_ammo",
    resultId: "sealing_ammo",
    resultName: recipe.name,
    resultEmoji: recipe.emoji || "💥",
    durability: null,
    coinCost,
    ammoAfter: (profile.sealing_ammo_count || 0) + 1,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

async function craftPioneerHammer(client, { userId, guildId, recipe }) {
  const profile = await getOrCreate(client, userId, guildId);
  if (profile.pioneer_hammer) return { ok: false, reason: "already_owned", recipe };

  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = ownedMaterial(profile, mat);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) return { ok: false, reason: "insufficient", missing, recipe };

  const inc = { craft_count_total: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (SPECIAL_MAT_FIELDS[mat]) {
      inc[SPECIAL_MAT_FIELDS[mat]] = (inc[SPECIAL_MAT_FIELDS[mat]] || 0) - need;
    } else if (isFishMaterial(mat)) {
      inc[`fish_bag.${mat}`] = (inc[`fish_bag.${mat}`] || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, pioneer_hammer: { $ne: true } },
    { $inc: inc, $set: { pioneer_hammer: true, updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "already_owned", recipe };

  return {
    ok: true,
    recipe,
    type: "pioneer_hammer",
    resultId: "pioneer_hammer",
    resultName: recipe.name,
    resultEmoji: recipe.emoji || "🔨",
    durability: null,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

module.exports = {
  craftItem,
  craftPioneerHammer,
  craftSealingAmmo,
  craftRepairTool,
  craftFishingNet,
  craftStoneAppraisalTrigger,
  craftAdvancedTrap,
  craftTreasureMap,
  craftOre,
  getRecipe,
  maxCraftTimes,
  PICKAXE_TIER,
  WEAPON_TIER,
  ROD_TIER,
  FRAGMENT_KEY,
};
