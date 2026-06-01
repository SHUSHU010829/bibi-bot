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
const applyQuestHooks = require("../../features/quests/applyQuestHooks");

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
    .setName("收成")
    .setDescription("收成成熟的作物 🌟")
    .setContexts(InteractionContextType.Guild)
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
      const plotIndex = (interaction.options.getInteger("地塊") || 1) - 1;
      const result = await farmService.harvestCrop(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });

      if (!result.ok) {
        if (result.reason === "disabled") return interaction.editReply("🔧 農場系統尚未啟動！");
        if (result.reason === "empty_plot") {
          return interaction.editReply({
            components: [errorContainer(
              "❌ 空地塊",
              `地塊 ${plotIndex + 1} 沒有種任何東西。`,
              "用 `/種植` 種點什麼吧",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "rotted") {
          const def = farming.crops?.[result.crop] || {};
          return interaction.editReply({
            components: [errorContainer(
              "🥀 作物已枯萎",
              `${def.emoji || ""} **${def.name || result.crop}** 已超過保鮮期，地塊已清空。`,
              "下次成熟後盡快收成！",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "under_raid") {
          const raid = result.plot.raid;
          return interaction.editReply({
            components: [errorContainer(
              "⚔️ 地塊被入侵！",
              `**${raid?.monsterEmoji || "👾"} ${raid?.monsterName || "怪物"}** 正在侵擾這塊地。`,
              "回 `/農場` 點「防禦」擊退牠才能收成",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        if (result.reason === "not_ready") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply({
            components: [errorContainer(
              "⏱️ 還沒成熟",
              `這塊地的作物還在成長，成熟時間：<t:${readyEpoch}:R>`,
              "用 `/施肥` 縮短成長時間",
            )],
            flags: MessageFlags.IsComponentsV2,
          });
        }
        return interaction.editReply("🔧 收成失敗，請稍後再試。");
      }

      const def = result.cropDef;
      const yieldText = result.yieldBonus > 0
        ? `（基礎 ${result.baseCoins} × 收成 +${Math.round(result.yieldBonus * 100)}%）`
        : "";

      const lines = [
        `🌾 收成：**${def.emoji} ${def.name}** ×1`,
        `💰 賣得金幣：**+${result.coins} 幣** ${yieldText}`,
      ];
      if (result.fertilizers.length > 0) {
        const fertNames = result.fertilizers
          .map((k) => farming.fertilizers?.[k]?.emoji || "")
          .join("");
        lines.push(`💧 已施肥：${fertNames}（${result.fertilizers.length} 次）`);
      }
      for (const drop of result.bonusDrops) {
        if (drop.kind === "fragment") lines.push(`✨ 額外掉落：傳說碎片 ×${drop.amount}`);
        if (drop.kind === "rare_bait") lines.push(`✨ 額外掉落：稀有魚餌 ×${drop.amount}`);
      }

      const container = new ContainerBuilder()
        .setAccentColor(0x2ecc71)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🌟 收成成功！`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 💡 蔬菜可用 `/烹飪` 製成 farm_yield buff，或 `/賣出` 賣給系統",
          ),
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`farm_view_${interaction.user.id}`)
              .setLabel("回到農場")
              .setEmoji("🌾")
              .setStyle(ButtonStyle.Secondary),
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      const hooks = [
        { questId: "daily_farm_harvest" },
        { questId: "weekly_farm_harvest" },
      ];
      if (result.crop === "black_rose") {
        hooks.push({ questId: "weekly_farm_rose" });
      }
      await applyQuestHooks(
        client,
        {
          interaction,
          user: interaction.user,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          member: interaction.member,
          username: interaction.user.username,
        },
        hooks,
      ).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /收成:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 收成失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
