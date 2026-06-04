require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { farming } = require("../../config");
const farmService = require("../../features/farm/farmService");
const reminder = require("../../features/reminders/cooldownReminderService");

function fertChoices() {
  return Object.entries(farming?.fertilizers || {}).map(([key, def]) => {
    const effect = [];
    if (def.growReductionPct) effect.push(`-${Math.round(def.growReductionPct * 100)}%`);
    if (def.yieldBonusPct) effect.push(`+${Math.round(def.yieldBonusPct * 100)}%收成`);
    return {
      name: `${def.emoji} ${def.name}（${effect.join("／") || "?"}）`,
      value: key,
    };
  });
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
    .setName("施肥")
    .setDescription("給作物施肥，加速成熟或提升收成 💧")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("肥料")
        .setDescription("要施的肥料")
        .setRequired(true)
        .addChoices(...fertChoices()),
    )
    .addIntegerOption((o) =>
      o
        .setName("地塊")
        .setDescription("地塊編號（1 起算）")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(farming?.maxPlots || 8),
    )
    .addIntegerOption((o) =>
      o
        .setName("次數")
        .setDescription("施幾次（每次消耗一份肥料；預設 1）")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();
    try {
      const fertilizerKey = interaction.options.getString("肥料");
      const plotIndex = (interaction.options.getInteger("地塊") || 1) - 1;
      const count = interaction.options.getInteger("次數") || 1;
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};

      const result = await farmService.fertilize(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        plotIndex, fertilizerKey, count,
      });

      if (!result.ok) {
        if (result.reason === "disabled") return interaction.editReply("🔧 農場系統尚未啟動！");
        if (result.reason === "invalid_fertilizer") return interaction.editReply("🔧 找不到這種肥料。");
        if (result.reason === "empty_plot") {
          return interaction.editReply({
            components: [errorContainer(
              "❌ 空地塊",
              `地塊 ${plotIndex + 1} 沒有作物可施肥。`,
              "用 `/種植` 先種點什麼",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "already_ready") {
          return interaction.editReply({
            components: [errorContainer(
              "🌟 已可收成",
              `這塊地的作物已經成熟，不需要再施肥。`,
              "用 `/收成 地塊:" + (plotIndex + 1) + "` 收成",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "already_rotted") {
          return interaction.editReply({
            components: [errorContainer(
              "🥀 作物已枯萎",
              `這塊地的作物超過保鮮期，已經沒救了。`,
              "回 `/農場` 點地塊重新種植",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "fertilizer_not_applicable") {
          const crop = farming.crops?.[result.crop] || {};
          return interaction.editReply({
            components: [errorContainer(
              "❌ 肥料不適用",
              `${fertDef.emoji || ""} **${fertDef.name || fertilizerKey}** 只對特定高階作物有效，** ${crop.name || result.crop}** 無法使用。`,
              "改用通用肥料（煤炭灰／堆肥／怪物黏液…）",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "insufficient_material") {
          const sourceLabel = result.source === "fish_bag" ? "魚袋" : "背包";
          return interaction.editReply({
            components: [errorContainer(
              "❌ 材料不足",
              `需要 ${sourceLabel}「${result.key}」**${result.need}**，但只有 **${result.have}**。`,
              "去 `/挖礦` `/釣魚` `/地下城` `/烹飪` 收集材料",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "growth_cap_reached") {
          return interaction.editReply({
            components: [errorContainer(
              "⛔ 已達加速上限",
              `這塊地的成長時間已縮短到上限（${Math.round((farming.growthReductionCapPct || 0.6) * 100)}%）。`,
              "等待收成或改施提升收成上限的肥料（章魚／月光露水）",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 施肥失敗，請稍後再試。");
      }

      const readyEpoch = Math.floor(result.newReadyAt / 1000);
      const lines = [
        `💧 施 ${fertDef.emoji} **${fertDef.name}** ×${result.consumed}（生效 ${result.appliedCount} 次）`,
      ];
      if (result.reductionMs > 0) {
        const mins = Math.round(result.reductionMs / 60000);
        lines.push(`⏱️ 成長時間 -${mins} 分鐘 → <t:${readyEpoch}:R>`);
      }
      if (result.newYieldBonus > 0) {
        lines.push(`🌟 累計收成加成：+${Math.round(result.newYieldBonus * 100)}%`);
      }

      const container = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 💧 施肥成功`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAt = await farmService.getNextReadyAt(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAt,
      }).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /施肥:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 施肥失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
