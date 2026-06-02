// 農場系統按鈕／選單處理器（Phase D）
//
// Button customId：
//   farm_plant_<ownerId>_<plotIndex>    — 開啟作物選單（StringSelect）
//   farm_harvest_<ownerId>_<plotIndex>  — 直接收成該地塊
//   farm_fert_<ownerId>_<plotIndex>     — 開啟肥料選單（StringSelect）
//   farm_defend_<ownerId>_<plotIndex>   — 戰鬥防禦
//   farm_expand_<ownerId>               — 直接走擴建流程
//   farm_view_<ownerId>                 — 重新顯示農場（從收成後跳回）
//   farm_sell_<ownerId>_<cropKey>       — 一鍵賣出整袋蔬菜
//
// StringSelect customId：
//   farm_plantsel_<ownerId>_<plotIndex>  — 玩家選擇要種的作物
//   farm_fertsel_<ownerId>_<plotIndex>   — 玩家選擇要施的肥料

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");

const { farming } = require("../../config");
const farmService = require("../../features/farm/farmService");
const { buildFarmContainer } = require("../../features/farm/farmView");
const { getOrCreate } = require("../../features/mining/miningProfile");
const applyQuestHooks = require("../../features/quests/applyQuestHooks");
const grantCoins = require("../../features/economy/grantCoins");

const BTN_PREFIXES = [
  "farm_plant_", "farm_harvest_", "farm_fert_", "farm_defend_",
  "farm_expand_", "farm_view_", "farm_sell_",
];
const SELECT_PREFIXES = ["farm_plantsel_", "farm_fertsel_"];

function parseId(customId, prefixes) {
  for (const p of prefixes) {
    if (!customId.startsWith(p)) continue;
    const action = p.slice(5, -1);
    const rest = customId.slice(p.length);
    const sepIdx = rest.indexOf("_");
    if (sepIdx < 0) return { action, ownerId: rest, payload: null };
    return {
      action,
      ownerId: rest.slice(0, sepIdx),
      payload: rest.slice(sepIdx + 1),
    };
  }
  return null;
}

function errContainer(title, body, hint) {
  const c = new ContainerBuilder()
    .setAccentColor(0xe74c3c)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint) c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
}

async function replyEphemeralContainer(interaction, container) {
  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
  return interaction.deferred || interaction.replied
    ? interaction.editReply(payload)
    : interaction.reply(payload);
}

async function renderFarm(interaction, client) {
  const userId = interaction.user.id;
  const guildId = interaction.guildId;
  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = farmService.getPlotCount(profile);
  const plots = await farmService.getPlots(client, userId, guildId, plotCount);
  for (const p of plots) {
    if (farmService.shouldTriggerRaid(p) && !p.raid?.active) {
      const raid = await farmService.markRaid(client, {
        userId, guildId, plotIndex: p.plotIndex,
      });
      if (raid) {
        p.status = "raided";
        p.raid = raid;
      }
    }
  }
  return buildFarmContainer({
    plots,
    userId,
    plotCount,
    maxPlots: farming.maxPlots || 8,
  });
}

// 提供「種植作物」select menu（按鈕觸發後的後續流程）
function buildPlantSelector(userId, plotIndex) {
  const options = Object.entries(farming.crops || {}).map(([key, def]) => {
    const hours = Math.round((def.growMs || 0) / 3600000);
    return {
      label: `${def.name}`,
      value: key,
      description: `${def.plantCost} 幣・${hours}h 成熟${def.seedKey ? "・需稀有種子" : ""}`,
      emoji: def.emoji,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`farm_plantsel_${userId}_${plotIndex}`)
      .setPlaceholder("選擇要種植的作物…")
      .addOptions(options),
  );
}

// 提供「施肥」select menu（每次施 1 份；想要批量請用 /施肥 次數）
function buildFertilizerSelector(userId, plotIndex) {
  const options = Object.entries(farming.fertilizers || {}).map(([key, def]) => {
    const effects = [];
    if (def.growReductionPct) effects.push(`-${Math.round(def.growReductionPct * 100)}% 成長`);
    if (def.yieldBonusPct) effects.push(`+${Math.round(def.yieldBonusPct * 100)}% 收成`);
    const desc = `${def.source === "fish_bag" ? "魚袋" : "背包"} ×${def.qty}・${effects.join("／")}`;
    return {
      label: def.name,
      value: key,
      description: desc.slice(0, 100),
      emoji: def.emoji,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`farm_fertsel_${userId}_${plotIndex}`)
      .setPlaceholder("選擇要使用的肥料（每次施一份）…")
      .addOptions(options),
  );
}

// 成功訊息（ephemeral Container），附「回到農場」按鈕
function buildSuccessContainer(title, body, userId, accent = 0x2ecc71) {
  return new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_view_${userId}`)
          .setLabel("回到農場")
          .setEmoji("🌾")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}

module.exports = async (client, interaction) => {
  // 接受 Button 與 StringSelectMenu 兩種互動
  const isBtn = interaction.isButton?.();
  const isSelect = interaction.isStringSelectMenu?.();
  if (!isBtn && !isSelect) return;

  const parsed = isBtn
    ? parseId(interaction.customId, BTN_PREFIXES)
    : parseId(interaction.customId, SELECT_PREFIXES);
  if (!parsed) return;

  if (interaction.user.id !== parsed.ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的農場！",
      flags: MessageFlags.Ephemeral,
    });
  }

  const { action, payload } = parsed;
  const plotIndex = payload != null && !Number.isNaN(Number(payload))
    ? Number.parseInt(payload, 10)
    : null;

  try {
    // ── view：重新渲染整個農場 ──
    if (action === "view") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const container = await renderFarm(interaction, client);
      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // ── plant 按鈕：彈出作物選單 ──
    if (action === "plant" && isBtn) {
      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🌱 選擇要在地塊 ${plotIndex + 1} 種的作物`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(buildPlantSelector(interaction.user.id, plotIndex))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 黑玫瑰需要先從地下城（Lv 30+）掉落種子才能種",
          ),
        );
      return replyEphemeralContainer(interaction, c);
    }

    // ── plantsel：使用者實際選了作物 ──
    if (action === "plantsel" && isSelect) {
      const cropKey = interaction.values?.[0];
      if (!cropKey) return;
      await interaction.deferReply();

      const result = await farmService.plantCrop(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        cropKey,
        plotIndex,
      });

      if (!result.ok) {
        if (result.reason === "missing_seed") {
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 需要稀有種子", `種植 **黑玫瑰** 需要 \`${result.seedKey}\` ×1。`, "黑玫瑰種子只能從地下城（Lv 30+）掉落"),
          );
        }
        if (result.reason === "insufficient_coins") {
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 金幣不足", `需要 **${result.need}** 幣，目前有 **${result.have}** 幣。`, "去 /打工、/挖礦 賺點本錢"),
          );
        }
        if (result.reason === "plot_occupied") {
          const def = farming.crops?.[result.existing.crop] || {};
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 地塊已佔用", `地塊 ${plotIndex + 1} 已種了 ${def.emoji || ""} ${def.name || result.existing.crop}。`, "等收成後再種"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 種植失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }

      const cropDef = result.crop;
      const readyEpoch = Math.floor(result.plot.ready_at / 1000);
      const c = buildSuccessContainer(
        `${cropDef.emoji} 種下 **${cropDef.name}**`,
        `📍 地塊：**${plotIndex + 1}**\n💸 花費：${cropDef.plantCost} 幣\n🌟 成熟：<t:${readyEpoch}:R>`,
        interaction.user.id,
        0x4a90a4,
      );
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      applyQuestHooks(client, ctxOf(interaction), [{ questId: "daily_farm_plant" }]).catch(() => {});
      return;
    }

    // ── fert 按鈕：彈出肥料選單 ──
    if (action === "fert" && isBtn) {
      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 💧 選擇要施在地塊 ${plotIndex + 1} 的肥料`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addActionRowComponents(buildFertilizerSelector(interaction.user.id, plotIndex))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 此處每次施一份。要批量施肥請用 `/施肥 次數:<N>`",
          ),
        );
      return replyEphemeralContainer(interaction, c);
    }

    // ── fertsel：使用者實際選了肥料 ──
    if (action === "fertsel" && isSelect) {
      const fertilizerKey = interaction.values?.[0];
      if (!fertilizerKey) return;
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};
      await interaction.deferReply();

      const result = await farmService.fertilize(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        plotIndex, fertilizerKey, count: 1,
      });

      if (!result.ok) {
        if (result.reason === "insufficient_material") {
          const src = result.source === "fish_bag" ? "魚袋" : "背包";
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 材料不足", `${src}「${result.key}」需要 **${result.need}**，目前 **${result.have}**。`, "去 /挖礦、/釣魚、/地下城、/烹飪 收集"),
          );
        }
        if (result.reason === "growth_cap_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("⛔ 已達加速上限", `這塊地的成長時間已縮短到上限（${Math.round((farming.growthReductionCapPct || 0.6) * 100)}%）。`, "改施提升收成上限的肥料（章魚／月光露水）"),
          );
        }
        if (result.reason === "fertilizer_not_applicable") {
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 肥料不適用", `${fertDef.emoji || ""} **${fertDef.name || fertilizerKey}** 不能用於這種作物。`, "改用通用肥料"),
          );
        }
        if (result.reason === "already_ready") {
          return replyEphemeralContainer(
            interaction,
            errContainer("🌟 已可收成", "這塊地的作物已成熟，無需施肥。", `直接點「收成」或用 /收成 地塊:${plotIndex + 1}`),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 施肥失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }

      const readyEpoch = Math.floor(result.newReadyAt / 1000);
      const mins = Math.round((result.reductionMs || 0) / 60000);
      const body = [
        `💧 ${fertDef.emoji} **${fertDef.name}** ×${result.consumed}`,
        mins > 0 ? `⏱️ 成長 -${mins} 分鐘 → <t:${readyEpoch}:R>` : null,
        result.newYieldBonus > 0 ? `🌟 累計收成 +${Math.round(result.newYieldBonus * 100)}%` : null,
      ].filter(Boolean).join("\n");
      const c = buildSuccessContainer("💧 施肥成功", body, interaction.user.id, 0x4a90a4);
      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── harvest：直接收成 ──
    if (action === "harvest") {
      await interaction.deferReply();
      const result = await farmService.harvestCrop(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });
      if (!result.ok) {
        const map = {
          rotted: ["🥀 作物已枯萎", "已超過保鮮期，地塊已清空。", "下次成熟後盡快收成！"],
          under_raid: ["⚔️ 地塊被入侵", "怪物正在侵擾這塊地。", "回主畫面點「防禦」擊退牠"],
          not_ready: ["⏱️ 還沒成熟", "作物還在成長中。", "用 /施肥 加速"],
          empty_plot: ["❌ 空地塊", `地塊 ${plotIndex + 1} 沒種任何東西。`, "用 /種植 種點什麼"],
        };
        const [t, b, h] = map[result.reason] || ["🔧 收成失敗", `原因：\`${result.reason}\``, ""];
        return replyEphemeralContainer(interaction, errContainer(t, b, h));
      }
      const def = result.cropDef;
      const yieldText = result.yieldBonus > 0 ? `（+${Math.round(result.yieldBonus * 100)}% 收成）` : "";
      const bonusText = result.bonusDrops
        .map((d) => d.kind === "fragment" ? `✨ 傳說碎片 ×${d.amount}` : `✨ 稀有魚餌 ×${d.amount}`)
        .join("、");
      const body = [
        `🌾 **${def.emoji} ${def.name}** ×1`,
        `💰 收益 **+${result.coins} 幣** ${yieldText}`,
        bonusText || null,
      ].filter(Boolean).join("\n");
      const c = buildSuccessContainer("🌟 收成成功", body, interaction.user.id);

      const hooks = [
        { questId: "daily_farm_harvest" },
        { questId: "weekly_farm_harvest" },
      ];
      if (result.crop === "black_rose") hooks.push({ questId: "weekly_farm_rose" });
      applyQuestHooks(client, ctxOf(interaction), hooks).catch(() => {});

      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── defend：戰鬥防禦 ──
    if (action === "defend") {
      await interaction.deferReply();
      const result = await farmService.defendRaid(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });
      if (!result.ok) {
        const map = {
          no_raid: ["⚠️ 沒有入侵中", "這塊地沒有怪物正在侵擾。", "回主畫面重新整理狀態"],
          no_stamina: ["🔋 體力不足", "防禦需要 1 點地下城體力。", "等體力回復或用體力藥水"],
          no_weapon: ["🗡️ 沒有武器", "防禦怪物需要持有武器。", "去 /合成 打造一把劍"],
        };
        const [t, b, h] = map[result.reason] || ["🔧 防禦失敗", `原因：\`${result.reason}\``, ""];
        return replyEphemeralContainer(interaction, errContainer(t, b, h));
      }
      const monster = result.monster;
      const lines = result.won
        ? [
            `⚔️ 擊退了 **${monster.monsterEmoji} ${monster.monsterName}**！`,
            `💰 戰利品：+${result.coinsGained} 幣${result.slimeGained > 0 ? `、💧 黏液 ×${result.slimeGained}` : ""}`,
            `🌟 作物保住了，可立即點「收成」`,
          ]
        : [
            `💀 被 **${monster.monsterEmoji} ${monster.monsterName}** 擊敗，作物被毀！`,
            `下次更早回來收成吧 🥲`,
          ];
      if (result.weaponBroke) lines.push(`💥 武器斷裂，已換回赤手！`);
      else if (typeof result.weaponDurabilityAfter === "number") {
        lines.push(`-# 武器耐久剩 ${result.weaponDurabilityAfter}`);
      }
      const c = buildSuccessContainer(
        result.won ? "🛡️ 防禦成功" : "💀 防禦失敗",
        lines.join("\n"),
        interaction.user.id,
        result.won ? 0x2ecc71 : 0xe74c3c,
      );
      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── expand：直接執行擴建 ──
    if (action === "expand") {
      await interaction.deferReply();
      const result = await farmService.expandFarm(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
      });
      if (!result.ok) {
        if (result.reason === "max_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("🏆 已達上限", `農場已擴建到 **${result.current}** 格，無法再擴展。`, ""),
          );
        }
        if (result.reason === "insufficient_coins") {
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 金幣不足", `擴建到 **${result.nextCount}** 格需要 **${result.need}** 幣，目前 **${result.have}** 幣。`, "去賺點本錢再回來"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 擴建失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }
      const c = buildSuccessContainer(
        "🏗️ 農場擴建成功",
        `📈 地塊 **${result.from} → ${result.to}** 格\n💸 花費：${result.cost} 幣`,
        interaction.user.id,
      );
      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── sell：一鍵賣出蔬菜（背包按鈕） ──
    if (action === "sell") {
      const cropKey = payload;
      const def = farming.crops?.[cropKey];
      const price = (farming.sellPrices || {})[cropKey];
      if (!def || price == null) {
        return replyEphemeralContainer(
          interaction,
          errContainer("❌ 無法賣出", "這種蔬菜不收購。", ""),
        );
      }
      await interaction.deferReply();
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const have = (profile.veggie_bag || {})[cropKey] || 0;
      if (have <= 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("❌ 沒有庫存", `菜籃裡已經沒有 ${def.emoji} **${def.name}**。`, ""),
        );
      }
      const total = have * price;
      await client.miningProfilesCollection.updateOne(
        { userId: interaction.user.id, guildId: interaction.guildId },
        { $inc: { [`veggie_bag.${cropKey}`]: -have }, $set: { updatedAt: new Date() } },
      );
      const grant = await grantCoins(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        amount: total,
        source: "farm_sell",
        meta: { veggie: cropKey, qty: have },
      });
      const c = buildSuccessContainer(
        `${def.emoji} 賣出 ${def.name}`,
        `${def.emoji} **${def.name}** ×${have}\n→ **+${total.toLocaleString()} 幣**\n餘額：${(grant?.doc?.totalCoins ?? 0).toLocaleString()}`,
        interaction.user.id,
      );
      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }
  } catch (error) {
    console.log(`[ERROR] handleFarmButton:\n${error}\n${error.stack}`.red);
    const fallback = errContainer("🔧 操作失敗", "發生未預期錯誤。", "請呼叫舒舒！");
    await replyEphemeralContainer(interaction, fallback).catch(() => {});
  }
};

function ctxOf(interaction) {
  return {
    interaction,
    user: interaction.user,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    member: interaction.member,
    username: interaction.user.username,
  };
}
