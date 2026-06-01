require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const farmService = require("../../features/farm/farmService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("農場擴建")
    .setDescription("花金幣解鎖更多地塊 🏗️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      const result = await farmService.expandFarm(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
      });

      if (!result.ok) {
        if (result.reason === "disabled") return interaction.editReply("🔧 農場系統尚未啟動！");
        if (result.reason === "max_reached") {
          const container = new ContainerBuilder()
            .setAccentColor(0xf1c40f)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`# 🏆 已達地塊上限`),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `你的農場已擴建到 **${result.current}** 格，無法再擴展。`,
              ),
            );
          return interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "insufficient_coins") {
          const container = new ContainerBuilder()
            .setAccentColor(0xe74c3c)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`# ❌ 金幣不足`),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `擴建到 **${result.nextCount}** 格需要 **${result.need}** 幣，你目前有 **${result.have}** 幣。`,
              ),
            )
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent("-# 去賺點本錢再回來"),
            );
          return interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 擴建失敗，請稍後再試。");
      }

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🏗️ 農場擴建成功！`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `📈 地塊 **${result.from} → ${result.to}** 格\n` +
              `💸 花費：${result.cost} 幣`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 用 `/農場` 查看新地塊、`/種植` 種下作物",
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /農場擴建:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 擴建失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
