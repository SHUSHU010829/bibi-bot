require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { createRoom } = require("../../features/gameRoom/service");

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

function threadUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("開房")
    .setDescription("開一間遊戲房討論串，房內可使用所有遊戲指令 🎮")
    .addStringOption((option) =>
      option
        .setName("類型")
        .setDescription("房間類型（預設公開）")
        .addChoices(
          { name: "公開：所有人都看得到、可加入", value: "public" },
          { name: "私人：只有被房主拉進來的人看得到", value: "private" }
        )
    )
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const visibility = interaction.options.getString("類型") || "public";
      const result = await createRoom(client, interaction, visibility);

      if (result.error === "not_text_channel") {
        return interaction.editReply({
          components: [
            errorContainer(
              "❌ 這裡不能開房",
              "遊戲房只能在一般文字頻道開（討論串裡不能再開討論串）。",
              "請回到文字頻道再使用 /開房。"
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (result.error === "already_open") {
        const existing = result.existing;
        const container = errorContainer(
          "❌ 你已經有一間開啟中的遊戲房",
          `**${existing.name}** 還開著，一人同時只能開一間。`,
          "先用房內釘選訊息的關房按鈕或 /關房 關閉，再開新的。"
        ).addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel("前往我的遊戲房")
              .setEmoji("🎮")
              .setStyle(ButtonStyle.Link)
              .setURL(threadUrl(existing.guildId, existing.threadId))
          )
        );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      if (result.error === "thread_create_failed") {
        return interaction.editReply({
          components: [
            errorContainer(
              "🔧 無法建立遊戲房",
              `Discord 回報：${result.detail}`,
              "私人房需要機器人有「建立私人討論串」權限，請稍後再試或呼叫舒舒。"
            ),
          ],
          flags: MessageFlags.IsComponentsV2,
        });
      }

      const { room } = result;
      const visibilityLabel =
        room.visibility === "private" ? "🔒 私人房" : "🌐 公開房";
      const inviteNote =
        room.visibility === "private"
          ? "\n-# 私人房只有被拉進來的人看得到，在房內 @提及 即可邀請別人。"
          : "";

      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## 🎮 ${room.name} 開好了！\n${visibilityLabel}・房內開放所有遊戲指令${inviteNote}`
          )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setLabel("進入遊戲房")
              .setEmoji("🎮")
              .setStyle(ButtonStyle.Link)
              .setURL(threadUrl(room.guildId, room.threadId))
          )
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /開房:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 開房失敗，請稍後再試或呼叫舒舒！")
        .catch(() => {});
    }
  },
};
