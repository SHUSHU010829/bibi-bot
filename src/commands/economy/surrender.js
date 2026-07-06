require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const { errorContainer, broadcast } = require("../../features/theft/theftView");
const theftBoard = require("../../features/theft/theftBoard");
const { COIN_EMOJI } = require("../../constants/coin");

module.exports = {
  channelBuckets: ["theft"],
  data: new SlashCommandBuilder()
    .setName("自首")
    .setDescription("向警方自首，繳保釋金解除通緝、拿回部分託管賞金 🙇")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!theft?.enabled || !client.wantedListCollection) {
        return interaction.editReply("🔧 盜賊系統尚未啟動！");
      }

      const result = await theftService.surrender(client, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.username,
        member: interaction.member,
      });

      if (!result.ok) {
        if (result.reason === "not_wanted") {
          return interaction.editReply({
            components: [
              errorContainer("🕊️ 你目前沒被通緝", "清白之身，無需自首。"),
            ],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply({
          components: [errorContainer("🔧 自首失敗", "系統忙碌或未啟動。", "稍後再試或呼叫舒舒。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const container = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🙇 你自首了\n` +
              `繳交保釋金 **${result.bail.toLocaleString()}** ${COIN_EMOJI}，` +
              `拿回託管賞金 **${result.refunded.toLocaleString()}** ${COIN_EMOJI}，通緝已解除。`
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 惡名下降了一些。金盆洗手也是一條路。")
        );

      // 公開洗白消息（自首是明面上的事）：推到通緝廣播頻道；未設定才退回當前頻道
      const washContainer = new ContainerBuilder()
        .setAccentColor(0x3498db)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🙇 通緝解除\n${interaction.user} 向警方自首，已繳交保釋金，重新做人。`
          )
        );
      const broadcasted = await broadcast(client, washContainer);
      if (!broadcasted) {
        await interaction.channel
          ?.send({ components: [washContainer], flags: MessageFlags.IsComponentsV2 })
          .catch(() => {});
      }
      theftBoard.refresh(client).catch(() => {});

      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /自首:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 自首失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
