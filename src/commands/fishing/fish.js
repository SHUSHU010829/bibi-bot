require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
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

// 冷卻中的 /釣魚 訊息上「🎫 使用 CD 縮短券」按鈕。
// 與挖礦的 mine_cd_use_ticket_ 分開：按完要刷新釣魚訊息（或冷卻歸零後直接再釣一次）。
const FISH_CD_TICKET_PREFIX = "fish_cd_use_ticket_";

function parseFishCdTicketId(customId) {
  if (!customId || !customId.startsWith(FISH_CD_TICKET_PREFIX)) return null;
  const ownerId = customId.slice(FISH_CD_TICKET_PREFIX.length);
  if (!ownerId) return null;
  return { ownerId };
}

function locationChoices() {
  return Object.entries(fishing?.locations || {}).map(([key, def]) => ({
    name: `${def.emoji} ${def.name}`,
    value: key,
  }));
}

function rodLabel(key) {
  const def = fishing?.rods?.[key] || {};
  return `${def.emoji || "🎣"} ${def.name || key}`;
}

function rodDurabilityLine(rodKey, durability, maxDurability) {
  if (!rodKey || rodKey === "bamboo" || durability === null || durability === undefined) {
    return `🪝 **目前釣竿**\n${rodLabel("bamboo")}（無耐久消耗）`;
  }
  const warn = fishing?.durabilityWarn || {};
  const label = rodLabel(rodKey);
  const maxText = typeof maxDurability === "number" ? `/${maxDurability}` : "";
  if (typeof warn.critical === "number" && durability <= warn.critical) {
    return `🚨 **釣竿快斷了！**\n${label} 只剩 **${durability}**${maxText} 次，再釣就會斷裂退回竹釣竿。\n-# 快去 \`/合成\` 一支新的！`;
  }
  if (typeof warn.low === "number" && durability <= warn.low) {
    return `⚠️ **釣竿耐久偏低**\n${label} 剩 **${durability}**${maxText} 次\n-# 建議先去 \`/合成\` 備一支。`;
  }
  return `🪝 **目前釣竿**\n${label}・耐久 ${durability}${maxText} 次`;
}

function buildCooldownView({
  ownerId,
  readyAt,
  cdTickets,
  cdTicketUsedToday,
  cdTicketDailyLimit,
  cdTicketReductionMs,
  notifyEnabled,
  rodKey,
  rodDurability,
  rodMaxDurability,
}) {
  const readyEpoch = Math.floor(readyAt / 1000);
  const reductionMin = Math.max(1, Math.round((cdTicketReductionMs || 0) / 60000));
  const overDailyLimit =
    cdTicketDailyLimit > 0 && cdTicketUsedToday >= cdTicketDailyLimit;

  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎣 釣竿還在等魚上鉤\n下次可釣魚：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        rodDurabilityLine(rodKey, rodDurability, rodMaxDurability),
      ),
    );

  if (cdTickets > 0 && !overDailyLimit) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `🎫 **CD 縮短券** ×${cdTickets}\n-# 立即 -${reductionMin} 分；冷卻歸零會自動再釣一次`,
          ),
        )
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${FISH_CD_TICKET_PREFIX}${ownerId}`)
            .setLabel(`使用 1 張（-${reductionMin} 分）`)
            .setStyle(ButtonStyle.Primary),
        ),
    );
  } else if (cdTickets > 0 && overDailyLimit) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🎫 今日 CD 縮短券已用 ${cdTicketUsedToday}/${cdTicketDailyLimit} 張，明天再用吧！`,
      ),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🎫 沒有 CD 縮短券，可到 `/商店` 看看，或等冷卻自然結束。",
      ),
    );
  }

  if (!notifyEnabled) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟釣魚到點通知。",
      ),
    );
  }

  return container;
}

async function dmRodLowDurability(interaction, rodKey, durabilityAfter, level) {
  const def = fishing?.rods?.[rodKey] || {};
  const head =
    level === "critical"
      ? `🚨 你的 **${def.emoji || ""} ${def.name || rodKey}** 只剩 **${durabilityAfter}** 次耐久，下一次釣魚就會斷！`
      : `⚠️ 你的 **${def.emoji || ""} ${def.name || rodKey}** 耐久剩 **${durabilityAfter}** 次，差不多該準備了。`;
  await interaction.user.send(
    `${head}\n趁還沒斷，到 \`/合成\` 再做一支吧！`
  );
}

async function executeFish(client, interaction, { location = "stream" } = {}) {
  try {
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
        const notifyState = await reminder.getState(client, {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          type: "fish",
        });
        const container = buildCooldownView({
          ownerId: interaction.user.id,
          readyAt: result.readyAt,
          cdTickets: result.cdTickets,
          cdTicketUsedToday: result.cdTicketUsedToday,
          cdTicketDailyLimit: result.cdTicketDailyLimit,
          cdTicketReductionMs: result.cdTicketReductionMs,
          notifyEnabled: !!notifyState?.enabled,
          rodKey: result.rodKey,
          rodDurability: result.rodDurability,
          rodMaxDurability: result.rodMaxDurability,
        });
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "level_locked") {
        const locName = fishing.locations[location]?.name || location;
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🔒 ${locName} 尚未解鎖`,
            ),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**解鎖條件**\n${result.locDesc}\n**目前等級**\nLv.${result.current}`,
            ),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 多打工、發言、聊聊天升等就能解鎖更高級的釣場～",
            ),
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      if (result.reason === "dungeon_locked") {
        const locName = fishing.locations[location]?.name || location;
        const container = new ContainerBuilder()
          .setAccentColor(0xe74c3c)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `# 🔒 ${locName} 尚未解鎖`,
            ),
          )
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**解鎖條件**\n${result.locDesc}\n**目前進度**\n地下城通關 ${result.current} / ${result.required} 次`,
            ),
          )
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "-# 多打地下城（`/地下城`）就能解鎖更高級的釣場～",
            ),
          );
        return interaction.editReply({
          components: [container],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      return interaction.editReply("🔧 釣魚失敗，請稍後再試。");
    }

    const rodDef = result.rodDef || {};
    const rodLabelText = `${rodDef.emoji || "🎣"} ${rodDef.name || "竹釣竿"}`;
    const successPct = Math.round((result.successRate || 0) * 100);

    // ── 沒上鉤：魚跑了 ──
    if (!result.caught) {
      const failEpoch = Math.floor(result.newCooldownAt / 1000);
      const failMsgs = fishing.failMessages || ["魚跑掉了…"];
      const failMsg = failMsgs[Math.floor(Math.random() * failMsgs.length)];
      const failContainer = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🎣 ${failMsg}`)
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `${result.locDef?.emoji || "🎣"} 釣魚地點：**${result.locDef?.name || location}**\n` +
              `🪝 使用釣竿：**${rodLabelText}**\n` +
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
    const warn = fishing.durabilityWarn || {};
    const showDura =
      result.rodKey !== "bamboo" && typeof result.rodDurabilityAfter === "number";
    let rodDuraText = "";
    let rodWarnLevel = null;
    if (showDura) {
      const after = result.rodDurabilityAfter;
      if (typeof warn.critical === "number" && after <= warn.critical) {
        rodDuraText = `（🚨 耐久剩 ${after}）`;
        rodWarnLevel = "critical";
      } else if (typeof warn.low === "number" && after <= warn.low) {
        rodDuraText = `（⚠️ 耐久剩 ${after}）`;
        rodWarnLevel = "low";
      } else {
        rodDuraText = `（耐久剩 ${after}）`;
      }
    }

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
            `🪝 使用釣竿：**${rodLabelText}**${rodDuraText}\n` +
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
    } else if (rodWarnLevel === "critical") {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🚨 **釣竿快斷了！**\n${rodLabelText} 只剩 **${result.rodDurabilityAfter}** 次，再釣就會斷裂退回竹釣竿。快去 \`/合成\` 一支新的！`
        )
      );
    } else if (rodWarnLevel === "low") {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `⚠️ **釣竿耐久偏低**\n${rodLabelText} 剩 **${result.rodDurabilityAfter}** 次，建議先去 \`/合成\` 備一支。`
        )
      );
    }

    if (result.rodDurabilityWarnCrossed) {
      dmRodLowDurability(
        interaction,
        result.rodKey,
        result.rodDurabilityAfter,
        result.rodDurabilityWarnCrossed,
      ).catch(() => {});
    }

    // 稀有副產物（例如熔岩湖撈到的月光露水）
    if (Array.isArray(result.rareDrops) && result.rareDrops.length > 0) {
      for (const drop of result.rareDrops) {
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `✨ **意外發現**：${drop.emoji || "🎁"} ${drop.name || drop.item} ×1（可用於 /施肥）`
          )
        );
      }
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

    const notifyState = await reminder.getState(client, {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      type: "fish",
    });
    const notifyEnabled = !!notifyState?.enabled;
    if (!notifyEnabled) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 🔔 想冷卻結束時收到提醒？用 `/通知設定` 開啟釣魚到點通知。",
        ),
      );
    }

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
    const location = interaction.options.getString("地點") || "stream";
    return executeFish(client, interaction, { location });
  },

  FISH_CD_TICKET_PREFIX,
  parseFishCdTicketId,
  buildCooldownView,
  executeFish,
};
