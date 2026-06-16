// 烹飪工坊按鈕 handler：分類分頁切換 + 按鈕烹飪（可一次多份、煤炭按份數疊加）。
//
// customId：
//   cookTab_<userId>_<category>             — 切換效果分類分頁
//   cookDo_<userId>_<recipeId>_<mode>_<amt> — 烹飪；mode: n(普通)/c(煤炭)，amt: 1/all

require("colors");
const { MessageFlags } = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const { getOrCreate } = require("../../features/mining/miningProfile");
const cookView = require("../../features/fishing/cookView");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

const { COOK_TAB_PREFIX, COOK_DO_PREFIX, COOK_CAT_IDS, COOK_CATS } = cookView;

function parseOwnerAndRest(customId, prefix) {
  const rest = customId.slice(prefix.length);
  const sep = rest.indexOf("_");
  if (sep < 0) return { ownerId: rest, rest: "" };
  return { ownerId: rest.slice(0, sep), rest: rest.slice(sep + 1) };
}

// 由 buff.type 反查食譜所屬分類，刷新時停留在同一分頁。
function categoryForRecipe(recipeId) {
  const type = fishing?.recipes?.[recipeId]?.buff?.type;
  const cat = COOK_CATS.find((c) => c.types.includes(type));
  return cat?.id || "mine";
}

async function refreshKitchen(client, interaction, category) {
  const view = await cookView.buildWorkshopView(client, {
    userId: interaction.user.id,
    guildId: interaction.guildId,
    displayName:
      interaction.member?.displayName ||
      interaction.user.displayName ||
      interaction.user.username,
    category,
  });
  await interaction.editReply(view);
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;

  // 分類分頁切換
  if (customId.startsWith(COOK_TAB_PREFIX)) {
    const { ownerId, rest: category } = parseOwnerAndRest(customId, COOK_TAB_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ 這不是你的廚房！", flags: MessageFlags.Ephemeral });
    }
    if (!COOK_CAT_IDS.includes(category)) return;
    await interaction.deferUpdate();
    try {
      await refreshKitchen(client, interaction, category);
    } catch (err) {
      console.log(`[ERROR] cookTab handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }

  // 烹飪
  if (customId.startsWith(COOK_DO_PREFIX)) {
    const { ownerId, rest } = parseOwnerAndRest(customId, COOK_DO_PREFIX);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ 這不是你的廚房！", flags: MessageFlags.Ephemeral });
    }
    const parts = rest.split("_");
    const amt = parts.pop();
    const mode = parts.pop();
    const recipeId = parts.join("_");
    const recipe = fishing?.recipes?.[recipeId];
    if (!recipe) return;

    await interaction.deferUpdate();
    try {
      const useCoal = mode === "c";
      let qty = 1;
      if (amt === "all") {
        const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
        qty = cookService.maxCookable(profile, recipe, { useCoal });
      }
      if (qty < 1) {
        await refreshKitchen(client, interaction, categoryForRecipe(recipeId)).catch(() => {});
        return;
      }

      const result = await cookService.cook(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId,
        useCoal,
        qty,
      });

      if (!result.ok) {
        const errView = cookView.buildErrorView({ recipe, result });
        await interaction.followUp({
          ...errView,
          flags: (errView.flags || 0) | MessageFlags.Ephemeral,
        });
        await refreshKitchen(client, interaction, categoryForRecipe(recipeId)).catch(() => {});
        return;
      }

      await interaction.followUp({
        ...cookView.buildSuccessView({ recipe, result, userId: interaction.user.id }),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      await refreshKitchen(client, interaction, categoryForRecipe(recipeId)).catch(() => {});

      applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [{ questId: "weekly_cook_50", delta: result.qty }],
      ).catch(() => {});
    } catch (err) {
      console.log(`[ERROR] cookDo handler:\n${err}\n${err.stack}`.red);
    }
    return;
  }
};
