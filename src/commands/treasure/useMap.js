require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const treasureMapService = require("../../features/treasure/treasureMapService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("使用藏寶圖")
    .setDescription("撕開一張藏寶圖，看看會發生什麼事 🗺️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      const result = await treasureMapService.useMap(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
      });

      if (!result.ok) {
        if (result.reason === "no_map") {
          const c = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `# ❌ 你沒有藏寶圖`,
              ),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `目前持有藏寶圖碎片：**${result.fragments || 0}** / 6`,
              ),
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `-# 集滿 6 張碎片，到 /工坊 「合成」分頁打造一張藏寶圖`,
              ),
            );
          return interaction.editReply({
            components: [c],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 使用失敗，請稍後再試。");
      }

      const { event, lines, mapsAfter } = result;
      const accent = event.id === "treasure_chest"
        ? 0xf1c40f
        : event.id === "mimic"
          ? 0xc0392b
          : event.id === "stamina_potion"
            ? 0x2ecc71
            : 0x95a5a6;
      const c = new ContainerBuilder()
        .setAccentColor(accent)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${event.emoji || "🗺️"} ${event.name}`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(event.text || ""),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(lines.join("\n") || "-# （無獎勵）"),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 你還有 **${mapsAfter}** 張藏寶圖`,
          ),
        );
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (err) {
      console.log(`[ERROR] /使用藏寶圖:\n${err}\n${err.stack}`.red);
      await interaction.editReply("🔧 使用失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
