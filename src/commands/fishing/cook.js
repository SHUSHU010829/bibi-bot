require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const { getFishingProfile } = require("../../features/fishing/fishService");

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

// 顯示食譜材料需求
function recipeMaterialsText(recipe, fishBag, backpack) {
  const lines = [];
  const fish = fishing.fish || {};
  for (const [key, need] of Object.entries(recipe.materials || {})) {
    const have = fishBag[key] || 0;
    const def = fish[key] || {};
    const ok = have >= need ? "✅" : "❌";
    lines.push(`${ok} ${def.emoji || "🐟"} ${def.name || key} ×${need}（持有 ${have}）`);
  }
  if (recipe.coalFuel > 0) {
    const have = backpack.coal || 0;
    const ok = have >= recipe.coalFuel ? "✅" : "⚠️";
    lines.push(
      `${ok} <:ore_coal:1509063448481366106> 煤炭 ×${recipe.coalFuel}（持有 ${have}）— *煤炭烤製可選*`
    );
  }
  return lines.join("\n");
}

module.exports = {
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

      // 先顯示材料確認（若沒足夠材料提早告知）
      const profile = await getFishingProfile(
        client,
        interaction.user.id,
        interaction.guildId
      );
      const fishBag = profile.fish_bag || {};
      const backpack = profile.backpack || {};

      const result = await cookService.cook(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        recipeId,
        useCoal,
      });

      if (!result.ok) {
        if (result.reason === "insufficient_fish") {
          const materialsText = recipeMaterialsText(recipe, fishBag, backpack);
          const errContainer = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# ❌ 材料不足\n無法烹飪 ${recipe.emoji} **${recipe.name}**`
              )
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `**所需材料**\n${materialsText}`
              )
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                "-# 前往 /釣魚 蒐集更多魚吧！"
              )
            );
          return interaction.editReply({
            components: [errContainer],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "insufficient_coal") {
          const errContainer = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# ❌ 煤炭不足\n煤炭烤製 **${recipe.name}** 需要 ×${result.coalNeeded} 煤炭`
              )
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `持有煤炭：${result.coalHave} 個　需要：${result.coalNeeded} 個`
              )
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                "-# 💡 不勾選「煤炭烤製」可用普通版本，效果稍弱但無需煤炭。"
              )
            );
          return interaction.editReply({
            components: [errContainer],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 烹飪失敗，請稍後再試。");
      }

      const { buffDef, isCoalEnhanced, coalUsed, newBuff } = result;
      const accentColor = isCoalEnhanced ? 0xff6b35 : 0x2ecc71;

      let buffDesc = "";
      if (newBuff.type === "work_income") {
        buffDesc = `打工收入 +${Math.round(newBuff.value * 100)}%`;
      } else if (newBuff.type === "dungeon_atk") {
        buffDesc = `地下城 ATK +${newBuff.value}`;
      } else if (newBuff.type === "mine_luck") {
        buffDesc = `挖礦幸運 +${Math.round(newBuff.value * 100)}%`;
      } else if (newBuff.type === "all_boost") {
        buffDesc = `全屬性 +${Math.round(newBuff.value * 100)}%`;
      } else if (newBuff.type === "fish_fortune") {
        buffDesc = `釣魚成功率 +${Math.round(newBuff.value * 100)}% ・ 稀有度提升`;
      }

      let durationDesc = "";
      if (newBuff.uses_left !== null && newBuff.uses_left !== undefined) {
        durationDesc = `持續 ${newBuff.uses_left} 次使用`;
      } else if (newBuff.expires_at) {
        durationDesc = `持續至 <t:${Math.floor(newBuff.expires_at / 1000)}:R>`;
      }

      const coalLine = isCoalEnhanced
        ? `\n🪨 消耗煤炭 ×${coalUsed}，獲得**強化版**效果！`
        : recipe.coalFuel > 0
        ? `\n-# 💡 加入 ${recipe.coalFuel} 個煤炭可升級效果（勾選「煤炭烤製」選項）`
        : "";

      const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${recipe.emoji} ${recipe.name} 烹飪完成！${isCoalEnhanced ? " 🔥" : ""}`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `✨ **獲得 Buff**：${buffDesc}\n` +
              `⏱️ ${durationDesc}${coalLine}`
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# ${recipe.description || ""}`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`fish_bag_${interaction.user.id}`)
              .setLabel("查看背包")
              .setStyle(ButtonStyle.Secondary)
          )
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /烹飪:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 烹飪失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
