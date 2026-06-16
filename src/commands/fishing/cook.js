require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const cookView = require("../../features/fishing/cookView");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

function recipeChoices() {
  return Object.entries(fishing?.recipes || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}`,
    value: key,
  }));
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
        .setDescription("直接製作的食物（不填則打開廚房，用按鈕分類烹飪）")
        .setRequired(false)
        .addChoices(...recipeChoices())
    )
    .addIntegerOption((o) =>
      o
        .setName("份數")
        .setDescription("一次製作幾份（預設 1，煤炭與材料按份數疊加）")
        .setMinValue(1)
        .setRequired(false)
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

      // 不指定食物 → 打開廚房（分類分頁，按鈕烹飪，ephemeral）
      if (!recipeId) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const view = await cookView.buildWorkshopView(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          displayName:
            interaction.member?.displayName ||
            interaction.user.displayName ||
            interaction.user.username,
        });
        return interaction.editReply(view);
      }

      await interaction.deferReply();

      const useCoal = interaction.options.getBoolean("煤炭烤製") ?? false;
      const qty = interaction.options.getInteger("份數") ?? 1;

      const recipe = fishing.recipes?.[recipeId];
      if (!recipe) {
        return interaction.editReply("❌ 找不到這個食譜！");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const result = await cookService.cook(client, {
        userId,
        guildId,
        recipeId,
        useCoal,
        qty,
      });

      if (!result.ok) {
        return interaction.editReply(cookView.buildErrorView({ recipe, result }));
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
        [{ questId: "weekly_cook_50", delta: result.qty }],
      ).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /烹飪:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 烹飪失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
