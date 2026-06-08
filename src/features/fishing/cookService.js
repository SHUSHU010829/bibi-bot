require("colors");
const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const foodBag = require("./foodBag");

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

// 消耗一次 work_income 的使用次數（打工時呼叫）
function consumeWorkIncomeUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "work_income");
}

// 消耗一次 fish_fortune 的使用次數（釣魚時呼叫）
function consumeFishFortuneUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "fish_fortune");
}

// 執行一次烹飪。產出進 food_bag（不立即套 buff，使用時才生效）。
async function cook(client, { userId, guildId, recipeId, useCoal = false }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const recipes = fishing.recipes || {};
  const recipe = recipes[recipeId];
  if (!recipe) return { ok: false, reason: "invalid_recipe" };

  const profile = await getOrCreate(client, userId, guildId);
  const fishBag = profile.fish_bag || {};
  const backpack = profile.backpack || {};
  const veggieBag = profile.veggie_bag || {};

  const missingFish = [];
  for (const [fishKey, need] of Object.entries(recipe.materials || {})) {
    const have = fishBag[fishKey] || 0;
    if (have < need) missingFish.push({ fish: fishKey, need, have });
  }
  if (missingFish.length > 0) {
    return { ok: false, reason: "insufficient_fish", missingFish };
  }

  const missingVeggies = [];
  for (const [veggieKey, need] of Object.entries(recipe.veggies || {})) {
    const have = veggieBag[veggieKey] || 0;
    if (have < need) missingVeggies.push({ veggie: veggieKey, need, have });
  }
  if (missingVeggies.length > 0) {
    return { ok: false, reason: "insufficient_veggies", missingVeggies };
  }

  const coalNeeded = useCoal ? (recipe.coalFuel || 0) : 0;
  if (coalNeeded > 0 && (backpack.coal || 0) < coalNeeded) {
    return {
      ok: false,
      reason: "insufficient_coal",
      coalNeeded,
      coalHave: backpack.coal || 0,
    };
  }

  const isCoalEnhanced = useCoal && coalNeeded > 0 && !!recipe.coalBuff;
  const buffDef = isCoalEnhanced ? recipe.coalBuff : recipe.buff;

  const instance = {
    id: foodBag.newId(),
    recipeId,
    cookedAt: Date.now(),
    useCoal: isCoalEnhanced,
  };

  // 原子更新：扣材料 + 扣煤炭 + 入食物倉庫 + 烹飪副產廚餘堆肥 + byproduct
  const inc = {};
  for (const [fishKey, need] of Object.entries(recipe.materials || {})) {
    inc[`fish_bag.${fishKey}`] = -need;
  }
  for (const [veggieKey, need] of Object.entries(recipe.veggies || {})) {
    inc[`veggie_bag.${veggieKey}`] = -need;
  }
  if (coalNeeded > 0) {
    inc["backpack.coal"] = -coalNeeded;
  }
  inc["backpack.compost"] = (inc["backpack.compost"] || 0) + 1;
  if (recipe.byproduct?.field && recipe.byproduct?.qty) {
    inc[recipe.byproduct.field] = (inc[recipe.byproduct.field] || 0) + recipe.byproduct.qty;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $push: { food_bag: instance },
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
    instance,
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

// 使用一份食物。
//   confirmOverwrite=false 且已有同 type buff → 回 { ok:false, reason:"overwrite_needed", existingBuff, preview }
//   否則 → 移除 instance、套上新 buff（value 已 × freshness）。
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
  const existingBuff = existingBuffs.find((b) => b.type === preview.type);
  if (existingBuff && !confirmOverwrite) {
    return { ok: false, reason: "overwrite_needed", existingBuff, preview, instance };
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

  const otherBuffs = existingBuffs.filter((b) => b.type !== newBuff.type);
  const updatedBuffs = [...otherBuffs, newBuff];

  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, "food_bag.id": instanceId },
    {
      $pull: { food_bag: { id: instanceId } },
      $set: { active_food_buffs: updatedBuffs, updatedAt: new Date() },
    }
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "not_found" };

  return { ok: true, instance, preview, newBuff, overwritten: !!existingBuff };
}

module.exports = {
  cleanExpiredBuffs,
  getActiveFoodBuffs,
  getFoodLuckBonus,
  getFoodAtkBonus,
  getFoodWorkBonus,
  getFoodFishBonus,
  getFoodFarmYieldBonus,
  consumeMineLuckUse,
  consumeWorkIncomeUse,
  consumeFishFortuneUse,
  consumeFarmYieldUse,
  cook,
  useFood,
  previewBuffFromInstance,
};
