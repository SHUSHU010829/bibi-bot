require("colors");
const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const foodBag = require("./foodBag");
const buildingService = require("../guild_club/buildingService");

// 食物合成與食物 buff 管理。
//
// 食物 buff 結構（存於 miningProfiles.active_food_buffs）：
//   { type, value, expires_at, uses_left }
//   - type:       "work_income" | "dungeon_atk" | "mine_luck" | "all_boost" | "fish_fortune"
//   - value:      數值（倍率或加成量）
//   - expires_at: ms timestamp；null = 不過期（依 uses_left）
//   - uses_left:  null = 依時間；>0 = 使用次數
//
// 煤炭烤製聯動：coalFuel > 0 的食譜，若玩家揀選消耗煤炭，
// 改套 coalBuff（效果更強、時效更長），礦石背包同步扣除煤炭。

// 清除過期或用完的食物 buff（回傳清除後的陣列，不修改 profile）
function cleanExpiredBuffs(buffs) {
  if (!Array.isArray(buffs)) return [];
  const now = Date.now();
  return buffs.filter((b) => {
    if (b.uses_left !== null && b.uses_left !== undefined && b.uses_left <= 0) return false;
    if (b.expires_at && b.expires_at <= now) return false;
    return true;
  });
}

// 取得有效的食物 buff 列表（已過濾過期）
function getActiveFoodBuffs(profile) {
  return cleanExpiredBuffs(profile?.active_food_buffs || []);
}

// 取得食物 buff 對挖礦幸運的加成（mine_luck + all_boost）
function getFoodLuckBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "mine_luck") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Number(b.value) || 0;
  }
  return bonus;
}

// 取得食物 buff 對地下城 ATK 的加成（dungeon_atk + all_boost × baseAtk）
// baseAtk 傳入是為了讓 all_boost 能按比例計算，若未傳入就只加絕對值
function getFoodAtkBonus(profile, baseAtk = 0) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_atk") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Math.round(baseAtk * (Number(b.value) || 0));
  }
  return bonus;
}

// Phase H+：取得食物 buff 對地下城 DEF 的加成（dungeon_def + all_boost × baseDef）
function getFoodDefBonus(profile, baseDef = 0) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_def") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Math.round(baseDef * (Number(b.value) || 0));
  }
  return bonus;
}

// Phase H+：取得食物 buff 對 HP 上限的加成（dungeon_hp_max + all_boost × 100）
function getFoodHpMaxBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_hp_max") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Math.round(100 * (Number(b.value) || 0));
  }
  return bonus;
}

// 取得食物 buff 對打工收入的倍率加成（work_income + all_boost）
// 回傳 0.XX（額外加成量，不是最終倍率）
function getFoodWorkBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "work_income") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Number(b.value) || 0;
  }
  return bonus;
}

// 取得食物 buff 對農場收成的倍率加成（farm_yield + all_boost）。
// 回傳額外加成量（例如 0.25 代表 +25%）。
function getFoodFarmYieldBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "farm_yield") bonus += Number(b.value) || 0;
    if (b.type === "all_boost") bonus += Number(b.value) || 0;
  }
  return bonus;
}

// 消耗一次 farm_yield 的使用次數（收成時呼叫）
function consumeFarmYieldUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "farm_yield");
}

// 取得食物 buff 對釣魚的加成（fish_fortune + all_boost）。
// fish_fortune.value 同時換算成「成功率加成」與「稀有度加成（×5 對齊釣竿 rareBonus 量級）」。
// 回傳 { success, rare }。
function getFoodFishBonus(profile) {
  let success = 0;
  let rare = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    const v = Number(b.value) || 0;
    if (b.type === "fish_fortune") {
      success += v;
      rare += v * 5;
    } else if (b.type === "all_boost") {
      success += v;
      rare += v * 5;
    }
  }
  return { success, rare };
}

// 消耗一次指定 type 的次數型食物 buff（uses_left > 0）。
// 找到第一個符合的就扣 1 次，清掉用完 / 過期的後同步寫回 DB。
// 回傳更新後的 active_food_buffs 陣列；沒有可消耗的就回傳 undefined。
async function consumeFoodBuffUse(client, userId, guildId, profile, type) {
  const buffs = getActiveFoodBuffs(profile);
  let consumed = false;
  const updated = buffs.map((b) => {
    if (!consumed && b.type === type && b.uses_left > 0) {
      consumed = true;
      return { ...b, uses_left: b.uses_left - 1 };
    }
    return b;
  });
  if (!consumed) return;
  const cleaned = cleanExpiredBuffs(updated);
  await client.miningProfilesCollection
    .updateOne(
      { userId, guildId },
      { $set: { active_food_buffs: cleaned, updatedAt: new Date() } }
    )
    .catch((e) => console.log(`[ERROR] consumeFoodBuffUse(${type}): ${e}`.red));
  return cleaned;
}

// 消耗一次 mine_luck 的使用次數（挖礦時呼叫）
function consumeMineLuckUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "mine_luck");
}

// 各行為會吃到的食物 buff 類型對照表。all_boost 是全屬性增幅，列入所有行為。
const FOOD_BUFF_ACTION_TYPES = {
  mine: ["mine_luck", "all_boost"],
  fish: ["fish_fortune", "all_boost"],
  work: ["work_income", "all_boost"],
  // Phase H+ 新增 dungeon_def / dungeon_hp_max 也吃進地下城分類
  dungeon: ["dungeon_atk", "dungeon_def", "dungeon_hp_max", "all_boost"],
  farm: ["farm_yield", "all_boost"],
};

// 取得單一 food buff 的顯示資料（emoji / name / desc / expire 子句）。
function describeFoodBuff(b) {
  const recipes = fishing?.recipes || {};
  const recipe =
    (b.recipeId && recipes[b.recipeId]) ||
    Object.values(recipes).find(
      (r) => r.buff?.type === b.type || r.coalBuff?.type === b.type,
    );
  const name = recipe?.name || b.type;
  const emoji = recipe?.emoji || "🍽️";
  let desc;
  if (b.type === "work_income") desc = `打工收入 +${Math.round(b.value * 100)}%`;
  else if (b.type === "dungeon_atk") desc = `地下城 ATK +${Math.round(b.value)}`;
  else if (b.type === "dungeon_def") desc = `地下城 DEF +${Math.round(b.value)}`;
  else if (b.type === "dungeon_hp_max") desc = `地下城 HP 上限 +${Math.round(b.value)}`;
  else if (b.type === "mine_luck") desc = `挖礦幸運 +${Math.round(b.value * 100)}%`;
  else if (b.type === "all_boost") desc = `全屬性 +${Math.round(b.value * 100)}%`;
  else if (b.type === "fish_fortune")
    desc = `釣魚成功率 +${Math.round(b.value * 100)}% ・ 稀有度提升`;
  else if (b.type === "farm_yield") desc = `農場收成 +${Math.round(b.value * 100)}%`;
  else desc = b.type;
  let expire = "";
  if (b.uses_left !== null && b.uses_left !== undefined) {
    expire = `（剩 ${b.uses_left} 次）`;
  } else if (b.expires_at) {
    expire = `（<t:${Math.floor(b.expires_at / 1000)}:R>）`;
  }
  return { emoji, name, desc, expire };
}

// 取得在指定行為下生效的食物 buff 顯示行（已過濾相關類型 + 過期清理）。
// 回傳 ["🐙 **章魚飯**：挖礦幸運 +12%（剩 4 次）", ...]
function formatFoodBuffLines(profile, action) {
  const types = FOOD_BUFF_ACTION_TYPES[action];
  if (!types) return [];
  return getActiveFoodBuffs(profile)
    .filter((b) => types.includes(b.type))
    .map((b) => {
      const { emoji, name, desc, expire } = describeFoodBuff(b);
      return `${emoji} **${name}**：${desc}${expire}`;
    });
}

// 消耗一次 work_income 的使用次數（打工時呼叫）
function consumeWorkIncomeUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "work_income");
}

// 消耗一次 fish_fortune 的使用次數（釣魚時呼叫）
function consumeFishFortuneUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "fish_fortune");
}

// 以目前材料計算某食譜最多可烹飪幾份。
// useCoal=true 時，煤炭也納入限制（每份消耗 recipe.coalFuel）。
function maxCookable(profile, recipe, { useCoal = false } = {}) {
  if (!recipe) return 0;
  const fishBag = profile?.fish_bag || {};
  const veggieBag = profile?.veggie_bag || {};
  const backpack = profile?.backpack || {};

  let max = Infinity;
  for (const [fishKey, need] of Object.entries(recipe.materials || {})) {
    if (need > 0) max = Math.min(max, Math.floor((fishBag[fishKey] || 0) / need));
  }
  for (const [veggieKey, need] of Object.entries(recipe.veggies || {})) {
    if (need > 0) max = Math.min(max, Math.floor((veggieBag[veggieKey] || 0) / need));
  }
  if (max === Infinity) max = 0;

  if (useCoal && (recipe.coalFuel || 0) > 0) {
    max = Math.min(max, Math.floor((backpack.coal || 0) / recipe.coalFuel));
  }
  return Math.max(0, max);
}

// 執行烹飪，一次可烹飪 qty 份。產出進 food_bag（不立即套 buff，使用時才生效）。
// 煤炭、材料、副產品皆按份數疊加。
async function cook(client, { userId, guildId, recipeId, useCoal = false, qty = 1 }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const recipes = fishing.recipes || {};
  const recipe = recipes[recipeId];
  if (!recipe) return { ok: false, reason: "invalid_recipe" };

  qty = Math.max(1, Math.floor(Number(qty) || 1));

  const profile = await getOrCreate(client, userId, guildId);
  const fishBag = profile.fish_bag || {};
  const backpack = profile.backpack || {};
  const veggieBag = profile.veggie_bag || {};

  const missingFish = [];
  for (const [fishKey, need] of Object.entries(recipe.materials || {})) {
    const total = need * qty;
    const have = fishBag[fishKey] || 0;
    if (have < total) missingFish.push({ fish: fishKey, need: total, have });
  }
  if (missingFish.length > 0) {
    return { ok: false, reason: "insufficient_fish", missingFish, qty };
  }

  const missingVeggies = [];
  for (const [veggieKey, need] of Object.entries(recipe.veggies || {})) {
    const total = need * qty;
    const have = veggieBag[veggieKey] || 0;
    if (have < total) missingVeggies.push({ veggie: veggieKey, need: total, have });
  }
  if (missingVeggies.length > 0) {
    return { ok: false, reason: "insufficient_veggies", missingVeggies, qty };
  }

  const coalPerPortion = useCoal ? (recipe.coalFuel || 0) : 0;
  const coalNeeded = coalPerPortion * qty;
  if (coalNeeded > 0 && (backpack.coal || 0) < coalNeeded) {
    return {
      ok: false,
      reason: "insufficient_coal",
      coalNeeded,
      coalHave: backpack.coal || 0,
      qty,
    };
  }

  const isCoalEnhanced = useCoal && coalPerPortion > 0 && !!recipe.coalBuff;
  const buffDef = isCoalEnhanced ? recipe.coalBuff : recipe.buff;

  // 公會農膳坊烹飪暴擊：每份獨立骰，命中 → 該份產 2 instance 而不是 1。
  const buildingBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const critRate = (buildingBuffs.cooking_crit_pct || 0) / 100;

  const now = Date.now();
  const instances = [];
  let critCount = 0;
  for (let i = 0; i < qty; i++) {
    const isCrit = critRate > 0 && Math.random() < critRate;
    if (isCrit) critCount += 1;
    const portions = isCrit ? 2 : 1;
    for (let j = 0; j < portions; j++) {
      instances.push({
        id: foodBag.newId(),
        recipeId,
        cookedAt: now,
        useCoal: isCoalEnhanced,
      });
    }
  }

  // 原子更新：扣材料 + 扣煤炭 + 入食物倉庫 + 烹飪副產廚餘堆肥 + byproduct（全部 × qty）
  const inc = {};
  for (const [fishKey, need] of Object.entries(recipe.materials || {})) {
    inc[`fish_bag.${fishKey}`] = -need * qty;
  }
  for (const [veggieKey, need] of Object.entries(recipe.veggies || {})) {
    inc[`veggie_bag.${veggieKey}`] = -need * qty;
  }
  if (coalNeeded > 0) {
    inc["backpack.coal"] = -coalNeeded;
  }
  inc["backpack.compost"] = (inc["backpack.compost"] || 0) + qty;
  if (recipe.byproduct?.field && recipe.byproduct?.qty) {
    inc[recipe.byproduct.field] = (inc[recipe.byproduct.field] || 0) + recipe.byproduct.qty * qty;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $push: { food_bag: { $each: instances } },
      $set: { updatedAt: new Date() },
    }
  );

  return {
    ok: true,
    recipe,
    recipeId,
    buffDef,
    isCoalEnhanced,
    coalUsed: coalNeeded,
    qty,
    instances,
    instance: instances[0],
    critCount,
  };
}

// 取得某 instance 套用後會產生的 buff（含 freshness 衰減）。
function previewBuffFromInstance(instance) {
  const recipe = fishing?.recipes?.[instance.recipeId];
  if (!recipe) return null;
  const isCoalEnhanced = !!instance.useCoal && (recipe.coalFuel || 0) > 0 && !!recipe.coalBuff;
  const buffDef = isCoalEnhanced ? recipe.coalBuff : recipe.buff;
  if (!buffDef) return null;
  const fresh = foodBag.freshness(instance);
  const value = (Number(buffDef.value) || 0) * fresh;
  return {
    type: buffDef.type,
    baseValue: Number(buffDef.value) || 0,
    value,
    freshness: fresh,
    isCoalEnhanced,
    durationMs: buffDef.durationMs || null,
    uses: typeof buffDef.uses === "number" ? buffDef.uses : null,
    label: buffDef.label || "",
    recipe,
  };
}

// all_boost 與任一單屬性 buff 互斥；同 type 之間也互斥。
function isConflictingBuff(newType, existingType) {
  if (newType === existingType) return true;
  if (newType === "all_boost" || existingType === "all_boost") return true;
  return false;
}

// 使用一份食物。
//   confirmOverwrite=false 且有衝突的 buff → 回 { ok:false, reason:"overwrite_needed", existingBuffs, preview }
//   否則 → 移除 instance、清掉衝突的 buff、套上新 buff（value 已 × freshness）。
async function useFood(client, { userId, guildId, instanceId, confirmOverwrite = false }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  await foodBag.sweepSpoiled(client, userId, guildId, profile).catch(() => {});

  const instance = (profile.food_bag || []).find((it) => it.id === instanceId);
  if (!instance) return { ok: false, reason: "not_found" };

  const fresh = foodBag.freshness(instance);
  if (fresh <= 0) return { ok: false, reason: "spoiled" };

  const preview = previewBuffFromInstance(instance);
  if (!preview) return { ok: false, reason: "invalid_recipe" };

  const now = Date.now();
  const existingBuffs = cleanExpiredBuffs(profile.active_food_buffs || []);
  const conflictingBuffs = existingBuffs.filter((b) => isConflictingBuff(preview.type, b.type));
  if (conflictingBuffs.length > 0 && !confirmOverwrite) {
    return { ok: false, reason: "overwrite_needed", existingBuffs: conflictingBuffs, preview, instance };
  }

  let newBuff;
  if (preview.uses != null) {
    newBuff = {
      type: preview.type,
      value: preview.value,
      expires_at: null,
      uses_left: preview.uses,
      recipeId: instance.recipeId,
      useCoal: !!instance.useCoal,
    };
  } else {
    newBuff = {
      type: preview.type,
      value: preview.value,
      expires_at: now + (preview.durationMs || 3600000),
      uses_left: null,
      recipeId: instance.recipeId,
      useCoal: !!instance.useCoal,
    };
  }

  const keptBuffs = existingBuffs.filter((b) => !isConflictingBuff(newBuff.type, b.type));
  const updatedBuffs = [...keptBuffs, newBuff];

  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, "food_bag.id": instanceId },
    {
      $pull: { food_bag: { id: instanceId } },
      $set: { active_food_buffs: updatedBuffs, updatedAt: new Date() },
    }
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "not_found" };

  return { ok: true, instance, preview, newBuff, overwritten: conflictingBuffs.length > 0 };
}

module.exports = {
  cleanExpiredBuffs,
  getActiveFoodBuffs,
  getFoodLuckBonus,
  getFoodAtkBonus,
  getFoodDefBonus,
  getFoodHpMaxBonus,
  getFoodWorkBonus,
  getFoodFishBonus,
  getFoodFarmYieldBonus,
  consumeMineLuckUse,
  consumeWorkIncomeUse,
  consumeFishFortuneUse,
  consumeFarmYieldUse,
  maxCookable,
  cook,
  useFood,
  previewBuffFromInstance,
  describeFoodBuff,
  formatFoodBuffLines,
};
