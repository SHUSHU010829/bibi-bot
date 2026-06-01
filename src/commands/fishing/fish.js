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

const { fishing } = require("../../config");
const fishService = require("../../features/fishing/fishService");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const reminder = require("../../features/reminders/cooldownReminderService");

function locationChoices() {
  return Object.entries(fishing?.locations || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}`,
    value: key,
  }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("釣魚")
    .setDescription("去釣魚！釣到的魚可賣錢或烹飪成強力食物 buff 🎣")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("地點")
        .setDescription("釣魚地點（不選則預設溪流）")
        .setRequired(false)
        .addChoices(...locationChoices())
    ),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const location = interaction.options.getString("地點") || "stream";
      const result = await fishService.fish(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        location,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 釣魚系統尚未啟動！");
        }
        if (result.reason === "cooldown") {
          const readyEpoch = Math.floor(result.readyAt / 1000);
          return interaction.editReply(
            `🎣 釣竿還在等魚上鉤！下次可釣魚：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
          );
        }
        if (result.reason === "level_locked") {
          return interaction.editReply(
            `🔒 **${fishing.locations[location]?.name || location}** 尚未解鎖！\n` +
              `解鎖條件：${result.locDesc}\n` +
              `你目前等級：${result.current}`
          );
        }
        if (result.reason === "dungeon_locked") {
          return interaction.editReply(
            `🔒 **${fishing.locations[location]?.name || location}** 尚未解鎖！\n` +
              `解鎖條件：${result.locDesc}\n` +
              `你目前地下城通關次數：${result.current} / ${result.required}`
          );
        }
        return interaction.editReply("🔧 釣魚失敗，請稍後再試。");
      }

      const rodDef = result.rodDef || {};
      const rodLabel = `${rodDef.emoji || "🎣"} ${rodDef.name || "竹釣竿"}`;
      const successPct = Math.round((result.successRate || 0) * 100);

      // ── 沒上鉤：魚跑了 ──
      if (!result.caught) {
        const failEpoch = Math.floor(result.newCooldownAt / 1000);
        const failContainer = new ContainerBuilder()
          .setAccentColor(0x95a5a6)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("# 🎣 魚跑掉了…")
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `${result.locDef?.emoji || "🎣"} 釣魚地點：**${result.locDef?.name || location}**\n` +
                `🪝 使用釣竿：**${rodLabel}**\n` +
                `🎯 本次成功率：**${successPct}%**`
            )
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `⏱️ 下次可釣：<t:${failEpoch}:R>（<t:${failEpoch}:t>）`
            )
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 💡 用更好的釣竿（/合成・/商店）或先吃 🍤 海鮮拼盤（/烹飪）能提升成功率與稀有度"
            )
          );

        await interaction.editReply({
          components: [failContainer],
          flags: MessageFlags.IsComponentsV2,
        });

        reminder.refreshIfEnabled(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "fish",
          readyAt: result.newCooldownAt,
        }).catch(() => {});
        return;
      }

      const { fishDef, locDef, newCooldownAt } = result;
      const readyEpoch = Math.floor(newCooldownAt / 1000);

      const rarityColor = {
        普通: 0x7fb2d8,
        稀有: 0x5865f2,
        傳說: 0xff6b6b,
      }[fishDef.rarity || "普通"] ?? 0x7fb2d8;

      const qty = result.qty || 1;
      const rodDuraText =
        result.rodKey !== "bamboo" && typeof result.rodDurabilityAfter === "number"
          ? `（耐久剩 ${result.rodDurabilityAfter}）`
          : "";

      const container = new ContainerBuilder()
        .setAccentColor(rarityColor)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# ${fishDef.emoji || "🐟"} 釣到了！**${fishDef.name || result.fish}**${qty > 1 ? ` ×${qty}` : ""}`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${locDef.emoji || "🎣"} 釣魚地點：**${locDef.name}**\n` +
              `🪝 使用釣竿：**${rodLabel}**${rodDuraText}\n` +
              `🎯 本次成功率：**${successPct}%**\n` +
              `✨ 稀有度：**${fishDef.rarity || "普通"}**\n` +
              `💰 收購價：**${fishDef.price || 0} 幣**${qty > 1 ? `（共 ${(fishDef.price || 0) * qty} 幣）` : ""}`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `⏱️ 下次可釣：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`
          )
        );

      if (result.rodBroke) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 🪝 你的釣竿斷了，已換回竹釣竿，快去 /合成 打造新的！"
          )
        );
      }

      // 如果這種魚有對應食譜，提示可以烹飪
      const matchedRecipe = Object.entries(fishing.recipes || {}).find(
        ([, r]) => r.materials?.[result.fish] !== undefined
      );
      if (matchedRecipe) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 💡 可烹飪成 ${matchedRecipe[1].emoji} ${matchedRecipe[1].name}（/烹飪）`
          )
        );
      }

      // 快捷操作按鈕：立刻賣掉 + 查看魚袋
      const userId = interaction.user.id;
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`fish_sell_${userId}_${result.fish}`)
            .setLabel(`立刻賣掉（+${fishDef.price} 幣）`)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`fish_bag_${userId}`)
            .setLabel("查看背包")
            .setStyle(ButtonStyle.Secondary)
        )
      );

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `-# 累計釣魚 ${result.fishCountTotal} 次`
        )
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });

      // 任務 hook：釣魚計數
      applyQuestHooks(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "fish_count",
        value: 1,
      }).catch(() => {});

      // 釣到傳說魚 hook
      if (fishDef.rarity === "傳說") {
        applyQuestHooks(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "legendary_fish_count",
          value: 1,
        }).catch(() => {});
      }

      // 冷卻提醒：只有已啟用通知的玩家才更新
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "fish",
        readyAt: newCooldownAt,
      }).catch(() => {});
    } catch (error) {
      console.log(`[ERROR] /釣魚:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 釣魚失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
