require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildStatusContainer } = require("../../features/economy/pendingTransferView");

module.exports = {
  channelBuckets: ["general", "marketplace", "mining"],

  data: new SlashCommandBuilder()
    .setName("待收")
    .setDescription("查看你送出（對方收了沒）與要收的待收轉帳 / 贈送 📮")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const { incoming, outgoing } = await pendingTransferService.listForUser(
        client,
        interaction.guildId,
        interaction.user.id
      );

      if (incoming.length === 0 && outgoing.length === 0) {
        return interaction.editReply("📭 你目前沒有待收，也沒有送出中的轉帳 / 贈送。");
      }

      return interaction.editReply({
        components: [buildStatusContainer({ incoming, outgoing })],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [] },
      });
    } catch (error) {
      console.log(`[ERROR] /待收:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
