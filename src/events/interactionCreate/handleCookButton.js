// 烹飪覆蓋確認按鈕處理器
//
// 支援的 customId：
//   cook_overwrite_<ownerId>_<coal01>_<recipeId>   — 確認覆蓋現有食物 buff 並烹飪
//   cook_cancel_<ownerId>                          — 取消烹飪、不消耗材料

require("colors");
const { MessageFlags } = require("discord.js");

const { fishing } = require("../../config");
const cookService = require("../../features/fishing/cookService");
const { getFishingProfile } = require("../../features/fishing/fishService");
const cookView = require("../../features/fishing/cookView");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;

  if (customId.startsWith(cookView.CANCEL_PREFIX)) {
    const ownerId = customId.slice(cookView.CANCEL_PREFIX.length);
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: "❌ 這不是你的烹飪！",
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      await interaction.update(cookView.buildCanceledView(null));
    } catch (err) {
      console.log(`[ERROR] cook cancel:\n${err}`.red);
    }
    return;
  }

  if (!customId.startsWith(cookView.CONFIRM_PREFIX)) return;

  const rest = customId.slice(cookView.CONFIRM_PREFIX.length);
  const firstSep = rest.indexOf("_");
  if (firstSep < 0) return;
  const ownerId = rest.slice(0, firstSep);
  const afterOwner = rest.slice(firstSep + 1);
  const secondSep = afterOwner.indexOf("_");
  if (secondSep < 0) return;
  const coalFlag = afterOwner.slice(0, secondSep);
  const recipeId = afterOwner.slice(secondSep + 1);
  const useCoal = coalFlag === "1";

  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的烹飪！",
      flags: MessageFlags.Ephemeral,
    });
  }

  const recipe = fishing?.recipes?.[recipeId];
  if (!recipe) {
    return interaction.reply({
      content: "❌ 找不到這個食譜！",
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await interaction.deferUpdate();

    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    const result = await cookService.cook(client, {
      userId,
      guildId,
      recipeId,
      useCoal,
    });

    if (!result.ok) {
      const profile = await getFishingProfile(client, userId, guildId);
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
  } catch (error) {
    console.log(`[ERROR] cook overwrite confirm:\n${error}\n${error.stack}`.red);
    await interaction.editReply("🔧 烹飪失敗，請稍後再試。").catch(() => {});
  }
};
