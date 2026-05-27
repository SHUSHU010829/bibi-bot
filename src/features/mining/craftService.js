require("colors");
const { mining, craft } = require("../../config");
const { getOrCreate } = require("./miningProfile");

// 鎬子階級（用於判定升級 / 同級 / 降級）
const PICKAXE_TIER = { wood: 0, iron: 1, gold: 2, diamond: 3 };

function getRecipe(recipeId) {
  return (craft?.recipes || []).find((r) => r.id === recipeId) || null;
}

// 合成裝備。confirm=true 時略過「替換仍可用鎬子」的二次確認。
async function craftItem(client, { userId, guildId, recipeId, confirm = false }) {
  if (!mining?.enabled || !craft?.recipes) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const recipe = getRecipe(recipeId);
  if (!recipe) return { ok: false, reason: "no_recipe" };

  const resultId = recipe.result?.id;
  const pdef = mining.pickaxes?.[resultId];
  if (!pdef) return { ok: false, reason: "no_recipe" };

  const profile = await getOrCreate(client, userId, guildId);
  const backpack = profile.backpack || {};

  // 材料檢查
  const missing = [];
  for (const [mat, need] of Object.entries(recipe.materials || {})) {
    const have = backpack[mat] || 0;
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, recipe };
  }

  // 替換確認：目前鎬子非木鎬、仍有耐久，且新鎬子階級 <= 目前階級（同級或降級）
  const curTier = PICKAXE_TIER[profile.pickaxe] ?? 0;
  const newTier = PICKAXE_TIER[resultId] ?? 0;
  const hasUsablePickaxe =
    profile.pickaxe !== "wood" &&
    typeof profile.pickaxe_durability === "number" &&
    profile.pickaxe_durability > 0;
  if (!confirm && hasUsablePickaxe && newTier <= curTier) {
    return {
      ok: false,
      reason: "confirm_needed",
      recipe,
      current: {
        pickaxe: profile.pickaxe,
        durability: profile.pickaxe_durability,
      },
    };
  }

  // 扣材料 + 換鎬子 + craft_count_total
  const dec = {};
  for (const [mat, need] of Object.entries(recipe.materials)) {
    dec[`backpack.${mat}`] = -need;
  }
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { ...dec, craft_count_total: 1 },
      $set: {
        pickaxe: resultId,
        pickaxe_durability: pdef.durability ?? null,
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    recipe,
    pickaxe: resultId,
    durability: pdef.durability ?? null,
    craftCountTotal: (profile.craft_count_total || 0) + 1,
  };
}

module.exports = { craftItem, getRecipe, PICKAXE_TIER };
