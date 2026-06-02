require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
      const preview = await farmService.previewExpand(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });

      if (!preview.ok) {
        if (preview.reason === "disabled") return interaction.editReply("🔧 農場系統尚未啟動！");
        if (preview.reason === "max_reached") {
          const container = new ContainerBuilder()
            .setAccentColor(0xf1c40f)
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`# 🏆 已達地塊上限`),
            )
            .addSeparatorComponents(new SeparatorBuilder())
            .addTextDisplayComponents(
              new TextDisplayBuilder().setContent(
                `你的農場已擴建到 **${preview.current}** 格，無法再擴展。`,
              ),
            );
          return interaction.editReply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 擴建失敗，請稍後再試。");
      }

      if (!preview.canAfford) {
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`# ❌ 金幣不足`),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `擴建 **${preview.current} → ${preview.nextCount}** 格需要 **${preview.cost.toLocaleString()}** 幣，目前有 **${preview.have.toLocaleString()}** 幣（還差 ${(preview.cost - preview.have).toLocaleString()}）。`,
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

      const container = new ContainerBuilder()
        .setAccentColor(0xf1c40f)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🏗️ 確認擴建農場？`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `📈 地塊：**${preview.current} → ${preview.nextCount}** 格\n` +
              `💸 花費：**${preview.cost.toLocaleString()}** 幣\n` +
              `💰 餘額：${preview.have.toLocaleString()} → ${(preview.have - preview.cost).toLocaleString()} 幣`,
          ),
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`farm_expandconfirm_${interaction.user.id}`)
              .setLabel("確認擴建")
              .setEmoji("🏗️")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`farm_expandcancel_${interaction.user.id}`)
              .setLabel("取消")
              .setStyle(ButtonStyle.Secondary),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 按下「確認擴建」後才會扣款"),
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
