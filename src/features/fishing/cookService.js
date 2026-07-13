require("colors");
const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const foodBag = require("./foodBag");
const buildingService = require("../guild_club/buildingService");

// 食物合成與食物 buff 管理。
//
// 食物 buff 結構（存於 miningProfiles.active_food_buffs）：
//   { type, value, expires_at, uses_left, charges? }
//   - type:       "work_income" | "dungeon_atk" | "mine_luck" | "all_boost" | "fish_fortune"
//   - value:      數值（倍率或加成量）；次數型 = 目前生效那份的值（charges 隊頭）
//   - expires_at: ms timestamp；null = 不過期（依 uses_left）
//   - uses_left:  null = 依時間；>0 = 使用次數（次數型 = charges 剩餘總和）
//   - charges:    次數型才有，FIFO 隊列 [{ value, uses }]。多次食用同類型會累計進來，
//                 逐次消耗時從隊頭扣，隊頭用完才換下一份的 value。時間型無此欄位。
//
// 煤炭烤製聯動：coalFuel > 0 的食譜，若玩家揀選消耗煤炭，
// 改套 coalBuff（效果更強、時效更長），礦石背包同步扣除煤炭。

// 把一個 buff 正規化成 charges 隊列（相容舊資料：無 charges 的次數型視為單一份）。
function normCharges(b) {
  if (Array.isArray(b?.charges)) return b.charges.filter((c) => c && c.uses > 0);
  if (b?.uses_left != null) return [{ value: Number(b.value) || 0, uses: b.uses_left }];
  return [];
}

// 次數型 buff 目前生效的 value（charges 隊頭）；時間型直接取 value。
function currentBuffValue(b) {
  if (Array.isArray(b?.charges) || b?.uses_left != null) {
    const head = normCharges(b)[0];
    return head ? Number(head.value) || 0 : 0;
  }
  return Number(b?.value) || 0;
}

// 從 charges 隊頭扣 n 次，回傳更新後的 buff（value / uses_left 同步隊頭與總和）。
function decrementCharges(b, n) {
  const charges = normCharges(b).map((c) => ({ ...c }));
  let rem = n;
  for (const c of charges) {
    if (rem <= 0) break;
    const take = Math.min(rem, c.uses);
    c.uses -= take;
    rem -= take;
  }
  const kept = charges.filter((c) => c.uses > 0);
  const uses_left = kept.reduce((s, c) => s + c.uses, 0);
  return { ...b, charges: kept, uses_left, value: kept.length ? kept[0].value : 0 };
}

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
    if (b.type === "mine_luck") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += currentBuffValue(b);
  }
  return bonus;
}

// 取得食物 buff 對地下城 ATK 的加成（dungeon_atk + all_boost × baseAtk）
// baseAtk 傳入是為了讓 all_boost 能按比例計算，若未傳入就只加絕對值
function getFoodAtkBonus(profile, baseAtk = 0) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_atk") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += Math.round(baseAtk * currentBuffValue(b));
  }
  return bonus;
}

// Phase H+：取得食物 buff 對地下城 DEF 的加成（dungeon_def + all_boost × baseDef）
function getFoodDefBonus(profile, baseDef = 0) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_def") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += Math.round(baseDef * currentBuffValue(b));
  }
  return bonus;
}

// Phase H+：取得食物 buff 對 HP 上限的加成（dungeon_hp_max + all_boost × 100）
function getFoodHpMaxBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "dungeon_hp_max") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += Math.round(100 * currentBuffValue(b));
  }
  return bonus;
}

// 取得食物 buff 對打工收入的倍率加成（work_income + all_boost）
// 回傳 0.XX（額外加成量，不是最終倍率）
function getFoodWorkBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "work_income") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += currentBuffValue(b);
  }
  return bonus;
}

// 取得食物 buff 對農場收成的倍率加成（farm_yield + all_boost）。
// 回傳額外加成量（例如 0.25 代表 +25%）。
function getFoodFarmYieldBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "farm_yield") bonus += currentBuffValue(b);
    if (b.type === "all_boost") bonus += currentBuffValue(b);
  }
  return bonus;
}

// 取得食物 buff 對釣魚冷卻的減免（fish_haste，計時型）。回傳小數（0.10 = -10%）。
function getFoodFishingCdBonus(profile) {
  let bonus = 0;
  for (const b of getActiveFoodBuffs(profile)) {
    if (b.type === "fish_haste") bonus += currentBuffValue(b);
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
    const v = currentBuffValue(b);
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
      return decrementCharges(b, 1);
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

// 一次消耗多份指定 type 的次數型食物 buff（批次收成用，一次寫回）。
// 依序從各 buff 扣，扣滿 count 或用光為止；有扣到才寫 DB。
async function consumeFoodBuffUses(client, userId, guildId, profile, type, count = 1) {
  if (count <= 0) return;
  const buffs = getActiveFoodBuffs(profile);
  let remaining = count;
  const updated = buffs.map((b) => {
    if (remaining > 0 && b.type === type && b.uses_left > 0) {
      const take = Math.min(remaining, b.uses_left);
      remaining -= take;
      return decrementCharges(b, take);
    }
    return b;
  });
  if (remaining === count) return;
  const cleaned = cleanExpiredBuffs(updated);
  await client.miningProfilesCollection
    .updateOne(
      { userId, guildId },
      { $set: { active_food_buffs: cleaned, updatedAt: new Date() } }
    )
    .catch((e) => console.log(`[ERROR] consumeFoodBuffUses(${type}): ${e}`.red));
  return cleaned;
}

// 一次消耗多次 farm_yield（一鍵收成時呼叫，避免逐塊寫 DB）
function consumeFarmYieldUses(client, userId, guildId, profile, count) {
  return consumeFoodBuffUses(client, userId, guildId, profile, "farm_yield", count);
}

// 消耗一次 mine_luck 的使用次數（挖礦時呼叫）
function consumeMineLuckUse(client, userId, guildId, profile) {
  return consumeFoodBuffUse(client, userId, guildId, profile, "mine_luck");
}

// 各行為會吃到的食物 buff 類型對照表。all_boost 是全屬性增幅，列入所有行為。
const FOOD_BUFF_ACTION_TYPES = {
  mine: ["mine_luck", "all_boost"],
  fish: ["fish_fortune", "fish_haste", "all_boost"],
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
  const v = currentBuffValue(b);
  let desc;
  if (b.type === "work_income") desc = `打工收入 +${Math.round(v * 100)}%`;
  else if (b.type === "dungeon_atk") desc = `地下城 ATK +${Math.round(v)}`;
  else if (b.type === "dungeon_def") desc = `地下城 DEF +${Math.round(v)}`;
  else if (b.type === "dungeon_hp_max") desc = `地下城 HP 上限 +${Math.round(v)}`;
  else if (b.type === "mine_luck") desc = `挖礦幸運 +${Math.round(v * 100)}%`;
  else if (b.type === "all_boost") desc = `全屬性 +${Math.round(v * 100)}%`;
  else if (b.type === "fish_fortune")
    desc = `釣魚成功率 +${Math.round(v * 100)}% ・ 稀有度提升`;
  else if (b.type === "fish_haste") desc = `釣魚冷卻 -${Math.round(v * 100)}%`;
  else if (b.type === "farm_yield") desc = `農場收成 +${Math.round(v * 100)}%`;
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

// 食用一份或多份食物（傳入要吃的 instance 陣列，必須同食譜同類型）。
//   confirmOverwrite=false 且有「不可累計」的衝突 buff → 回 overwrite_needed。
//   次數型：同 type 既有 buff 直接累計 charges（不需覆蓋確認）；只有 all_boost 這類跨類型衝突才需覆蓋。
//   時間型：維持覆蓋語意（同 type / all_boost 互斥）。
async function applyFoodInstances(client, { userId, guildId, instances, confirmOverwrite = false }) {
  const fresh = instances.filter((it) => foodBag.freshness(it) > 0);
  if (fresh.length === 0) return { ok: false, reason: "spoiled" };

  const previews = fresh.map((it) => previewBuffFromInstance(it)).filter(Boolean);
  if (previews.length === 0) return { ok: false, reason: "invalid_recipe" };

  const type = previews[0].type;
  const isUseBased = previews[0].uses != null;
  const now = Date.now();
  const existingBuffs = cleanExpiredBuffs(
    (await getOrCreate(client, userId, guildId)).active_food_buffs || []
  );
  const conflicts = existingBuffs.filter((b) => isConflictingBuff(type, b.type));

  // 次數型：同 type 的既有 buff 是「累計對象」，不算需覆蓋的衝突。
  const accumulateTarget = isUseBased
    ? conflicts.find((b) => b.type === type)
    : null;
  const removableConflicts = conflicts.filter((b) => b !== accumulateTarget);

  if (removableConflicts.length > 0 && !confirmOverwrite) {
    return {
      ok: false,
      reason: "overwrite_needed",
      existingBuffs: removableConflicts,
      preview: previews[0],
      instances: fresh,
      qty: fresh.length,
    };
  }

  let newBuff;
  if (isUseBased) {
    const addedCharges = previews.map((p) => ({ value: p.value, uses: p.uses }));
    const charges = [...normCharges(accumulateTarget || {}), ...addedCharges].filter(
      (c) => c.uses > 0
    );
    const uses_left = charges.reduce((s, c) => s + c.uses, 0);
    newBuff = {
      type,
      value: charges.length ? charges[0].value : previews[0].value,
      expires_at: null,
      uses_left,
      charges,
      recipeId: fresh[0].recipeId,
      useCoal: !!fresh[0].useCoal,
    };
  } else {
    newBuff = {
      type,
      value: previews[0].value,
      expires_at: now + (previews[0].durationMs || 3600000),
      uses_left: null,
      recipeId: fresh[0].recipeId,
      useCoal: !!fresh[0].useCoal,
    };
  }

  const keptBuffs = existingBuffs.filter((b) => !conflicts.includes(b));
  const updatedBuffs = [...keptBuffs, newBuff];

  const ids = fresh.map((it) => it.id);
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $pull: { food_bag: { id: { $in: ids } } },
      $set: { active_food_buffs: updatedBuffs, updatedAt: new Date() },
    }
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    instance: fresh[0],
    instances: fresh,
    preview: previews[0],
    newBuff,
    qty: fresh.length,
    accumulated: !!accumulateTarget,
    overwritten: removableConflicts.length > 0,
  };
}

// 食用單一指定 instance（烹飪成功「立刻食用」、食物倉庫單份食用）。
async function useFood(client, { userId, guildId, instanceId, confirmOverwrite = false }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  await foodBag.sweepSpoiled(client, userId, guildId, profile).catch(() => {});

  const instance = (profile.food_bag || []).find((it) => it.id === instanceId);
  if (!instance) return { ok: false, reason: "not_found" };

  return applyFoodInstances(client, {
    userId,
    guildId,
    instances: [instance],
    confirmOverwrite,
  });
}

// 食用某食譜最舊的 qty 份（次數型食物選份數食用）。
async function useFoodPortions(client, { userId, guildId, recipeId, qty = 1, confirmOverwrite = false }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  qty = Math.max(1, Math.floor(Number(qty) || 1));

  const profile = await getOrCreate(client, userId, guildId);
  await foodBag.sweepSpoiled(client, userId, guildId, profile).catch(() => {});
  const refreshed = await getOrCreate(client, userId, guildId);

  const oldestFirst = foodBag
    .listFresh(refreshed)
    .filter((it) => it.recipeId === recipeId)
    .sort((a, b) => a.freshness - b.freshness);
  if (oldestFirst.length === 0) return { ok: false, reason: "not_found" };

  const instances = oldestFirst.slice(0, Math.min(qty, oldestFirst.length));
  return applyFoodInstances(client, { userId, guildId, instances, confirmOverwrite });
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
  getFoodFishingCdBonus,
  consumeMineLuckUse,
  consumeWorkIncomeUse,
  consumeFishFortuneUse,
  consumeFarmYieldUse,
  consumeFarmYieldUses,
  maxCookable,
  cook,
  useFood,
  useFoodPortions,
  previewBuffFromInstance,
  describeFoodBuff,
  formatFoodBuffLines,
};
