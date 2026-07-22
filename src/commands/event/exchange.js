require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const eventExchangeService = require("../../features/event/eventExchangeService");
const { buildExchangeView } = require("../../features/event/eventExchangeView");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("兌換所")
    .setDescription("用活動限定魚兌換限定獎勵 🎣")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { active, items } = await eventExchangeService.listExchanges(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      const view = buildExchangeView({
        ownerId: interaction.user.id,
        active,
        items,
      });
      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /兌換所:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 兌換所開啟失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
