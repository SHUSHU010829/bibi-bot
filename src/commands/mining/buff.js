require("colors");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { buildStatusView } = require("../../features/buff/buffView");
const { appendNav } = require("../../features/playerStatus/statusNav");

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("狀態")
    .setDescription("查看體力、所有加成與生效中 Buff（身分組／食物／公會／活動）✨")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const view = await buildStatusView(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        displayName:
          interaction.member?.displayName || interaction.user.username,
      });
      appendNav(view, interaction.user.id, "buff");
      await interaction.editReply(view);
    } catch (error) {
      console.log(`[ERROR] /狀態:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查詢狀態失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
