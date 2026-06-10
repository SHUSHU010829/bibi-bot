require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require("discord.js");

const {
  getRoom,
  closeRoom,
  findOpenRoomByOwner,
} = require("../../features/gameRoom/service");

function errorContainer(title, detail, hint) {
  const container = new ContainerBuilder()
    .setAccentColor(0xed4245)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(detail));
  if (hint) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${hint}`)
    );
  }
  return container;
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("關房")
    .setDescription("關閉你的遊戲房（在房內或任何地方都可以用）🚪")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const cached = getRoom(interaction.channelId);
      let targetThreadId = null;

      if (cached) {
        const isAdmin = interaction.memberPermissions?.has(
          PermissionFlagsBits.Administrator
        );
        if (cached.ownerId !== interaction.user.id && !isAdmin) {
          return interaction.editReply({
            components: [
              errorContainer(
                "❌ 這不是你的遊戲房",
                `這間房的房主是 <@${cached.ownerId}>，只有房主（或管理員）能關房。`,
                "想開自己的房就用 /開房。"
              ),
            ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
        }
        targetThreadId = interaction.channelId;
      } else {
        const room = await findOpenRoomByOwner(
          client,
          interaction.guildId,
          interaction.user.id
        );
        if (!room) {
          return interaction.editReply({
            components: [
              errorContainer(
                "❌ 找不到你的遊戲房",
                "你目前沒有開啟中的遊戲房。",
                "用 /開房 就能開一間。"
              ),
            ],
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
        }
        targetThreadId = room.threadId;
      }

      // 先回覆再封存，避免討論串鎖住後訊息發不出去
      await interaction.editReply("🚪 遊戲房已關閉，討論串將鎖定並封存。");
      await closeRoom(client, targetThreadId, {
        closedBy: interaction.user.id,
        reason: "command",
      });
    } catch (error) {
      console.log(`[ERROR] /關房:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 關房失敗，請稍後再試或呼叫舒舒！")
        .catch(() => {});
    }
  },
};
