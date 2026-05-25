require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { shop } = require("../../config");
const { buildInventoryView } = require("../../features/shop/inventoryView");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("背包")
    .setDescription("查看你購買的道具與生效中的 buff 🎒")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    if (!shop?.enabled) {
      return interaction.reply({
        content: "🔧 商店系統尚未啟動！",
        flags: MessageFlags.Ephemeral,
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.userInventoryCollection || !client.userCoinsCollection) {
        return interaction.editReply("🔧 商店系統尚未就緒");
      }

      const view = await buildInventoryView(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
      });

      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /背包:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 背包讀取失敗").catch(() => {});
    }
  },
};
