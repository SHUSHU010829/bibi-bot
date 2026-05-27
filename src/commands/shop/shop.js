require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { shop } = require("../../config");
const { buildShopView } = require("../../features/shop/shopView");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("商店")
    .setDescription("逛商店：買道具、加成藥水、顏色身份組、卡面風格 🛒")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    if (!shop?.enabled) {
      return interaction.reply({
        content: "🔧 商店系統尚未啟動！",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply();

    try {
      await interaction.editReply(buildShopView(0, 0));
    } catch (error) {
      console.log(`[ERROR] /商店:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 商店開啟失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
