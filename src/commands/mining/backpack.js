require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");

const { mining, shop } = require("../../config");
const { buildBackpackView } = require("../../features/shop/backpackView");
const { appendNav } = require("../../features/playerStatus/statusNav");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("背包")
    .setDescription("查看背包容量與道具：礦石、釣魚、農場、商店物品 🎒（加成請用 /狀態）")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    if (!mining?.enabled && !shop?.enabled) {
      return interaction.reply({
        content: "🔧 背包系統尚未啟動！",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const view = await buildBackpackView(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        displayName:
          interaction.member?.displayName ||
          interaction.user.displayName ||
          interaction.user.username,
      });

      appendNav(view, interaction.user.id, "backpack");
      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /背包:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看背包失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
