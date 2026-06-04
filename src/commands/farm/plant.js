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

const { farming } = require("../../config");
const farmService = require("../../features/farm/farmService");
const reminder = require("../../features/reminders/cooldownReminderService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

function cropChoices() {
  return Object.entries(farming?.crops || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}（${def.plantCost} 幣・${Math.round((def.growMs || 0) / 3600000)}h）`,
    value: key,
  }));
}

function errorContainer(title, body, hint) {
  return new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("種植")
    .setDescription("在指定地塊種下作物 🌱")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("作物")
        .setDescription("要種的作物")
        .setRequired(true)
        .addChoices(...cropChoices()),
    )
    .addIntegerOption((o) =>
      o
        .setName("地塊")
        .setDescription("地塊編號（1 起算）")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(farming?.maxPlots || 8),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      const cropKey = interaction.options.getString("作物");
      const plotIndex = (interaction.options.getInteger("地塊") || 1) - 1;
      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const result = await farmService.plantCrop(client, {
        userId, guildId,
        username: interaction.user.username,
        member: interaction.member,
        cropKey, plotIndex,
      });

      if (!result.ok) {
        if (result.reason === "disabled") return interaction.editReply("🔧 農場系統尚未啟動！");
        if (result.reason === "invalid_crop") return interaction.editReply("🔧 找不到這種作物。");
        if (result.reason === "invalid_plot") {
          return interaction.editReply({
            components: [errorContainer(
              "❌ 地塊不存在",
              `你目前只有 **${result.plotCount}** 塊地。`,
              "用 `/農場擴建` 解鎖更多地塊",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "plot_occupied") {
          const def = farming.crops?.[result.existing.crop] || {};
          return interaction.editReply({
            components: [errorContainer(
              "❌ 地塊已佔用",
              `地塊 ${plotIndex + 1} 已經種了 ${def.emoji || ""} ${def.name || result.existing.crop}。`,
              "等收成後再種；爛掉的作物可直接覆蓋",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "missing_seed") {
          return interaction.editReply({
            components: [errorContainer(
              "❌ 需要稀有種子",
              `種植 **黑玫瑰** 需要 \`${result.seedKey}\` ×1。`,
              "黑玫瑰種子只能從地下城（Lv 30↑）掉落",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "insufficient_coins") {
          return interaction.editReply({
            components: [errorContainer(
              "❌ 金幣不足",
              `種植需要 **${result.need}** 幣，你目前有 **${result.have}** 幣。`,
              "去 `/打工`、`/挖礦` 賺點本錢",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 種植失敗，請稍後再試。");
      }

      const cropDef = result.crop;
      const plot = result.plot;
      const readyEpoch = Math.floor(plot.ready_at / 1000);
      const rotEpoch = Math.floor(plot.expires_at / 1000);

      const container = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${cropDef.emoji} 種下 **${cropDef.name}**`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `📍 地塊：**${plotIndex + 1}**\n` +
              `💸 種植成本：${cropDef.plantCost} 幣\n` +
              `🌟 成熟：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）\n` +
              `🥀 凋萎於：<t:${rotEpoch}:R>`,
          ),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 💡 用 `/施肥` 加速成長（煤炭灰／堆肥／怪物黏液／月光露水…）",
          ),
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`farm_fert_${interaction.user.id}_${plotIndex}`)
              .setLabel("立即施肥")
              .setEmoji("💧")
              .setStyle(ButtonStyle.Secondary),
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAt = await farmService.getNextReadyAt(client, userId, guildId);
      reminder.refreshIfEnabled(client, {
        userId, guildId, type: "farm", readyAt: nextReadyAt,
      }).catch(() => {});

      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId, guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        [{ questId: "daily_farm_plant" }],
      ).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /種植:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 種植失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
