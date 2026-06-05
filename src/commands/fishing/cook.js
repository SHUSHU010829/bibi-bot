require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const { getFishingProfile } = require("../../features/fishing/fishService");
const cookView = require("../../features/fishing/cookView");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

const VEGGIE_LABELS = {
  carrot: { emoji: "🥕", name: "紅蘿蔔" },
  corn: { emoji: "🌽", name: "玉米" },
  strawberry: { emoji: "🍓", name: "草莓" },
  black_rose: { emoji: "🌹", name: "黑玫瑰" },
};

function recipeChoices() {
  return Object.entries(fishing?.recipes || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}`,
    value: key,
  }));
}

// 顯示所有食譜一覽
function buildRecipeListView() {
  const fish = fishing.fish || {};
  const recipes = fishing.recipes || {};

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🍳 烹飪食譜一覽")
    )
    .addSeparatorComponents(new SeparatorBuilder());

  for (const [, recipe] of Object.entries(recipes)) {
    const matLines = Object.entries(recipe.materials || {}).map(([key, qty]) => {
      const def = fish[key] || {};
      return `${def.emoji || "🐟"} ${def.name || key} ×${qty}`;
    });
    for (const [key, qty] of Object.entries(recipe.veggies || {})) {
      const def = VEGGIE_LABELS[key] || {};
      matLines.push(`${def.emoji || "🌱"} ${def.name || key} ×${qty}`);
    }
    if (recipe.coalFuel > 0) {
      matLines.push(`<:ore_coal:1509063448481366106> 煤炭 ×${recipe.coalFuel}（煤炭烤製，可選）`);
    }

    const normalLabel = recipe.buff?.label || "";
    const coalLabel = recipe.coalBuff?.label || "";

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${recipe.emoji} ${recipe.name}\n` +
        `**材料**：${matLines.join("、")}\n` +
        `**效果**：${normalLabel}\n` +
        (coalLabel ? `**煤炭加強**：${coalLabel}\n` : "") +
        `-# ${recipe.description || ""}`
      )
    );
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  channelBuckets: ["fishing", "farm"],
  data: new SlashCommandBuilder()
    .setName("烹飪")
    .setDescription("用魚類食材製作 buff 食物，消耗煤炭可升級效果 🍳")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("食物")
        .setDescription("要製作的食物（不填則顯示所有食譜）")
        .setRequired(false)
        .addChoices(...recipeChoices())
    )
    .addBooleanOption((o) =>
      o
        .setName("煤炭烤製")
        .setDescription("是否消耗煤炭提升效果（需持有足夠煤炭）")
        .setRequired(false)
    ),

  run: async (client, interaction) => {
    try {
      if (!fishing?.enabled || !client.miningProfilesCollection) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply("🔧 釣魚系統尚未啟動！");
      }

      const recipeId = interaction.options.getString("食物");

      if (!recipeId) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        return interaction.editReply(buildRecipeListView());
      }

      await interaction.deferReply();

      const useCoal = interaction.options.getBoolean("煤炭烤製") ?? false;

      const recipe = fishing.recipes?.[recipeId];
      if (!recipe) {
        return interaction.editReply("❌ 找不到這個食譜！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profile = await getFishingProfile(client, userId, guildId);

      const result = await cookService.cook(client, {
        userId,
        guildId,
        recipeId,
        useCoal,
      });

      if (!result.ok) {
        const view = cookView.buildErrorView({
          recipe,
          result,
          fishBag: profile.fish_bag || {},
          backpack: profile.backpack || {},
          veggieBag: profile.veggie_bag || {},
        });
        return interaction.editReply(view);
      }

      await interaction.editReply(cookView.buildSuccessView({ recipe, result, userId }));

      applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId,
          guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [{ questId: "weekly_cook_50" }],
      ).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /烹飪:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 烹飪失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
