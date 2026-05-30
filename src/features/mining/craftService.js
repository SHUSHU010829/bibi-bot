require("colors");
const { mining, craft, dungeon } = require("../../config");
const { getOrCreate } = require("./miningProfile");

// 鎬子 / 武器階級（用於判定升級 / 同級 / 降級）
const PICKAXE_TIER = { wood: 0, iron: 1, gold: 2, diamond: 3 };
const WEAPON_TIER = {
  fist: 0,
  iron_sword: 1,
  steel_sword: 2,
  gold_sword: 3,
  diamond_sword: 4,
  legendary_sword: 5,
};

// 特殊材料：傳說素材碎片存在 profile.legendary_fragments，不在 backpack 內。
const FRAGMENT_KEY = "legendary_fragment";

function getRecipe(recipeId) {
  return (craft?.recipes || []).find((r) => r.id === recipeId) || null;
}

// 依裝備類型回傳該裝備的定義表與玩家身上的對應欄位名稱。
function resolveSlot(type) {
  if (type === "weapon") {
    return {
      defs: dungeon?.weapons || {},
      tiers: WEAPON_TIER,
      equippedField: "weapon",
      durabilityField: "weapon_durability",
      defaultId: "fist",
    };
  }
  // 預設視為鎬子
  return {
    defs: mining?.pickaxes || {},
    tiers: PICKAXE_TIER,
    equippedField: "pickaxe",
    durabilityField: "pickaxe_durability",
    defaultId: "wood",
  };
}

// 玩家目前持有某材料的數量（傳說碎片走獨立欄位）。
function ownedMaterial(profile, mat) {
  if (mat === FRAGMENT_KEY) return profile.legendary_fragments || 0;
  return (profile.backpack || {})[mat] || 0;
}

// 合成裝備（鎬子 / 武器）。confirm=true 時略過「替換仍可用裝備」的二次確認。
async function craftItem(client, { userId, guildId, recipeId, confirm = false }) {
  if (!mining?.enabled || !craft?.recipes) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, reason: "no_recipe" };

  const type = recipe.result?.type || "pickaxe";
  const resultId = recipe.result?.id;
  const slot = resolveSlot(type);
  const targetDef = slot.defs[resultId];
  if (!targetDef) return { ok: false, reason: "no_recipe" };

  const profile = await getOrCreate(client, userId, guildId);

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

  // 扣材料（傳說碎片走獨立欄位）+ 換裝備 + craft_count_total
  const inc = { craft_count_total: 1 };
  for (const [mat, need] of Object.entries(recipe.materials)) {
    if (mat === FRAGMENT_KEY) {
      inc.legendary_fragments = (inc.legendary_fragments || 0) - need;
    } else {
      inc[`backpack.${mat}`] = (inc[`backpack.${mat}`] || 0) - need;
    }
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        [slot.equippedField]: resultId,
        [slot.durabilityField]: targetDef.durability ?? null,
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
    durability: targetDef.durability ?? null,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

module.exports = { craftItem, getRecipe, PICKAXE_TIER, WEAPON_TIER, FRAGMENT_KEY };
