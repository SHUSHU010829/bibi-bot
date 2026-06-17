// 農場系統按鈕／選單處理器（Phase D）
//
// Button customId：
//   farm_plant_<ownerId>_<plotIndex>    — 開啟作物選單（StringSelect）
//   farm_harvest_<ownerId>_<plotIndex>  — 直接收成該地塊
//   farm_fert_<ownerId>_<plotIndex>     — 開啟肥料選單（StringSelect）
//   farm_fertall_<ownerId>              — 一鍵施肥：開啟肥料選單
//   farm_fertallcfm_<ownerId>_<fertKey> — 確認執行一鍵施肥
//   farm_fertallcancel_<ownerId>        — 取消一鍵施肥確認
//   farm_fertagain_<ownerId>_<plotIndex>_<fertKey>_<count> — 對同地塊再施 N 份（count: 1/3/5/max）
//   farm_fertrest_<ownerId>_<plotIndex>_<fertKey> — 對其他成長中地塊各施 1 份
//   farm_defend_<ownerId>_<plotIndex>   — 戰鬥防禦
//   farm_expand_<ownerId>               — 顯示擴建確認預覽
//   farm_expandconfirm_<ownerId>        — 確認後實際扣款並擴建
//   farm_expandcancel_<ownerId>         — 取消擴建確認
//   farm_view_<ownerId>                 — 重新顯示農場（從收成後跳回）
//   farm_sell_<ownerId>_<cropKey>       — 一鍵賣出整袋蔬菜
//
// StringSelect customId：
//   farm_plantsel_<ownerId>_<plotIndex>  — 玩家選擇要種的作物
//   farm_fertsel_<ownerId>_<plotIndex>   — 玩家選擇要施的肥料
//   farm_fertallsel_<ownerId>            — 一鍵施肥的肥料選擇

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
const orePriceEngine = require("../../features/market/orePriceEngine");
const {
  sendFarmAnnouncement,
  buildHarvestAnnouncement,
  buildDefendAnnouncement,
  buildTrapAnnouncement,
} = require("../../features/farm/farmAnnouncer");
const { resolveStamina, staminaMax, getMemberClub } = require("../../features/mining/dungeonService");
const reminder = require("../../features/reminders/cooldownReminderService");

const BTN_PREFIXES = [
  "farm_plantall_", "farm_plant_", "farm_harvestall_", "farm_harvest_",
  "farm_fertallcancel_", "farm_fertallcfm_", "farm_fertall_",
  "farm_fertagain_", "farm_fertrest_", "farm_fert_",
  "farm_defend_", "farm_trap_",
  "farm_expandconfirm_", "farm_expandcancel_", "farm_expand_",
  "farm_view_", "farm_sell_",
];
const SELECT_PREFIXES = ["farm_plantallsel_", "farm_plantsel_", "farm_fertallsel_", "farm_fertsel_"];

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
        userId, guildId, plotIndex: p.plotIndex, fromStatus: p.status,
      });
      if (raid) {
        p.status = "raided";
        p.raid = raid;
      }
    }
  }
  const club = await getMemberClub(client, interaction.user.id, interaction.guildId);
  const sMax = staminaMax(interaction.member, club);
  const stamina = resolveStamina(profile, sMax).stamina;
  return buildFarmContainer({
    plots,
    userId,
    plotCount,
    maxPlots: farming.maxPlots || 8,
    stamina,
  });
}

// 提供「種植作物」select menu（按鈕觸發後的後續流程）
function buildPlantSelector(userId, plotIndex, { profile, coins } = {}) {
  const options = Object.entries(farming.crops || {}).map(([key, def]) => {
    const hours = Math.round((def.growMs || 0) / 3600000);
    const seedQty = def.seedKey ? (profile?.seed_bag?.[def.seedKey] || 0) : 0;
    const willUseSeedFree = def.seedKey && def.seedOptional && seedQty >= 1;
    const parts = [];
    if (willUseSeedFree) {
      parts.push(`🌱 用種子免費（剩${seedQty}）`);
    } else {
      parts.push(`${def.plantCost}幣`);
      if (def.seedKey && !def.seedOptional) {
        parts.push(`種子${seedQty >= 1 ? "✅" : "❌"}${seedQty}`);
      }
      if (typeof coins === "number" && coins < def.plantCost) parts.push("幣不足");
    }
    parts.push(`${hours}h 成熟`);
    return {
      label: def.name,
      value: key,
      description: parts.join("・").slice(0, 100),
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

// 提供「施肥」select menu（每次施 1 份；批量可用施肥後的「再施 N 份」按鈕）
function buildFertilizerSelector(userId, plotIndex, { profile } = {}) {
  const options = Object.entries(farming.fertilizers || {}).map(([key, def]) => {
    const effects = [];
    if (def.growReductionPct) effects.push(`-${Math.round(def.growReductionPct * 100)}%成長`);
    if (def.yieldBonusPct) effects.push(`+${Math.round(def.yieldBonusPct * 100)}%收成`);
    const sourceField = def.source === "fish_bag" ? "fish_bag" : "backpack";
    const sourceLabel = def.source === "fish_bag" ? "魚袋" : "背包";
    const have = (profile?.[sourceField] || {})[def.key] || 0;
    const enough = have >= (def.qty || 1);
    const haveLabel = `你有${have}${enough ? "✅" : "❌"}`;
    const desc = `${sourceLabel}×${def.qty}・${haveLabel}・${effects.join("／")}`;
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

// 把玩家目前所有「肥料原料」彙整成一行；source 來自 farming.fertilizers
function fertilizerInventoryLine(profile) {
  const parts = [];
  for (const def of Object.values(farming.fertilizers || {})) {
    const sourceField = def.source === "fish_bag" ? "fish_bag" : "backpack";
    const have = (profile?.[sourceField] || {})[def.key] || 0;
    parts.push(`${def.emoji} ${def.name} ×${have}`);
  }
  return parts.join("　");
}

async function fetchUserCoins(client, userId, guildId) {
  const doc = await client.userCoinsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  return doc?.totalCoins || 0;
}

// 單塊施肥成功後的訊息：附「再施 ×N」「對其他地塊」「回到農場」快捷按鈕。
// 按鈕會即時讀取剩餘材料與其他成長中地塊數，無法操作的就不顯示對應按鈕。
async function buildFertSuccessContainer(client, { userId, guildId, plotIndex, fertilizerKey, result, title = "💧 施肥成功", accent = 0x4a90a4 }) {
  const fertDef = farming.fertilizers?.[fertilizerKey] || {};
  const readyEpoch = Math.floor(result.newReadyAt / 1000);
  const mins = Math.round((result.reductionMs || 0) / 60000);
  const partial = result.appliedCount < (result.requestedCount || result.appliedCount);
  const body = [
    `💧 ${fertDef.emoji} **${fertDef.name}** ×${result.consumed}（生效 ${result.appliedCount} 次${partial ? "・部分達上限" : ""}）`,
    mins > 0 ? `⏱️ 成長 -${mins} 分鐘 → <t:${readyEpoch}:R>` : null,
    result.newYieldBonus > 0 ? `🌟 累計收成 +${Math.round(result.newYieldBonus * 100)}%` : null,
  ].filter(Boolean).join("\n");

  const c = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));

  const profile = await getOrCreate(client, userId, guildId);
  const sourceField = fertDef.source === "fish_bag" ? "fish_bag" : "backpack";
  const have = (profile[sourceField] || {})[fertDef.key] || 0;
  const perPlot = fertDef.qty || 1;
  const materialMax = Math.floor(have / perPlot);

  const plotCount = farmService.getPlotCount(profile);
  const plots = await farmService.getPlots(client, userId, guildId, plotCount);
  const otherGrowing = plots.filter((p) => {
    if (p.plotIndex === plotIndex) return false;
    const live = farmService.resolveLiveStatus(p);
    if (!live.crop || live.status !== "growing") return false;
    if (Array.isArray(fertDef.onlyCrops) && !fertDef.onlyCrops.includes(live.crop)) return false;
    return true;
  }).length;

  if (materialMax > 0) {
    const reRow = new ActionRowBuilder();
    for (const n of [1, 3, 5]) {
      if (n > materialMax) continue;
      reRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_fertagain_${userId}_${plotIndex}_${fertilizerKey}_${n}`)
          .setLabel(`再施 ×${n}`)
          .setEmoji("💧")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (materialMax > 5) {
      reRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`farm_fertagain_${userId}_${plotIndex}_${fertilizerKey}_max`)
          .setLabel(`再施 ×最多（${materialMax}）`)
          .setEmoji("💧")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (reRow.components.length > 0) {
      c.addActionRowComponents(reRow);
    }
  }

  const row2 = new ActionRowBuilder();
  if (otherGrowing > 0 && materialMax >= 1) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`farm_fertrest_${userId}_${plotIndex}_${fertilizerKey}`)
        .setLabel(`對其他 ${otherGrowing} 塊各施 1 份`)
        .setEmoji("🌾")
        .setStyle(ButtonStyle.Primary),
    );
  }
  row2.addComponents(
    new ButtonBuilder()
      .setCustomId(`farm_view_${userId}`)
      .setLabel("回到農場")
      .setEmoji("🌾")
      .setStyle(ButtonStyle.Secondary),
  );
  c.addActionRowComponents(row2);

  return c;
}

// 文字化跳過理由，做成 -# 小字摘要
function skippedSummaryLine(skipped) {
  if (!skipped?.length) return null;
  const labels = {
    already_ready: "已成熟",
    already_rotted: "已枯萎",
    under_raid: "被入侵",
    fertilizer_not_applicable: "肥料不適用",
    growth_cap_reached: "已達加速上限",
    yield_cap_reached: "已達收成上限",
  };
  const counts = new Map();
  for (const s of skipped) {
    const k = labels[s.reason] || s.reason;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const parts = [...counts.entries()].map(([k, v]) => `${k} ${v}`);
  return `-# 跳過 ${skipped.length} 塊：${parts.join("・")}`;
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
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const coins = await fetchUserCoins(client, interaction.user.id, interaction.guildId);
      const seedParts = [];
      for (const def of Object.values(farming.crops || {})) {
        if (!def.seedKey) continue;
        const qty = profile?.seed_bag?.[def.seedKey] || 0;
        seedParts.push(`${def.emoji} ${def.name}種子 ×${qty}`);
      }
      const summary = [
        `💰 你有 **${coins.toLocaleString()}** 幣`,
        seedParts.length ? `🌱 ${seedParts.join("　")}` : null,
      ].filter(Boolean).join("\n");

      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🌱 選擇要在地塊 ${plotIndex + 1} 種的作物`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(summary))
        .addActionRowComponents(buildPlantSelector(interaction.user.id, plotIndex, { profile, coins }))
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
      const costParts = [];
      if (result.seedConsumed) costParts.push(`🌱 ${cropDef.emoji} 種子 ×1`);
      if (result.coinsPaid > 0) costParts.push(`${result.coinsPaid} 幣`);
      const costLine = costParts.join(" + ") || "免費";
      const c = buildSuccessContainer(
        `${cropDef.emoji} 種下 **${cropDef.name}**`,
        `📍 地塊：**${plotIndex + 1}**\n💸 花費：${costLine}\n🌟 成熟：<t:${readyEpoch}:R>`,
        interaction.user.id,
        0x4a90a4,
      );
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtPlant = await farmService.getNextReadyAt(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtPlant,
      }).catch(() => {});

      applyQuestHooks(client, ctxOf(interaction), [{ questId: "daily_farm_plant" }]).catch(() => {});
      return;
    }

    // ── plantall 按鈕：算出空地數，彈出作物選單 ──
    if (action === "plantall" && isBtn) {
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profile = await getOrCreate(client, userId, guildId);
      const coins = await fetchUserCoins(client, userId, guildId);
      const plotCount = farmService.getPlotCount(profile);
      const plots = await farmService.getPlots(client, userId, guildId, plotCount);
      const emptyCount = plots.filter((p) => !p.crop || p.status === "rotted").length;

      if (emptyCount === 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🌾 沒有空地", "目前所有地塊都已種植或被入侵。", "等收成後再來"),
        );
      }

      const seedParts = [];
      for (const def of Object.values(farming.crops || {})) {
        if (!def.seedKey) continue;
        const qty = profile?.seed_bag?.[def.seedKey] || 0;
        seedParts.push(`${def.emoji} ${def.name}種子 ×${qty}`);
      }
      const summary = [
        `🌾 將為 **${emptyCount}** 塊空地種上同一種作物`,
        `💰 你有 **${coins.toLocaleString()}** 幣`,
        seedParts.length ? `🌱 ${seedParts.join("　")}` : null,
      ].filter(Boolean).join("\n");

      const options = Object.entries(farming.crops || {}).map(([key, def]) => {
        const hours = Math.round((def.growMs || 0) / 3600000);
        const seedQty = def.seedKey ? (profile?.seed_bag?.[def.seedKey] || 0) : 0;
        const seedUses = def.seedOptional ? Math.min(seedQty, emptyCount) : 0;
        const coinSlots = emptyCount - seedUses;
        const totalCost = (def.plantCost || 0) * coinSlots;
        const parts = [];
        if (seedUses > 0) parts.push(`🌱×${seedUses}免費`);
        if (totalCost > 0) parts.push(`共${totalCost.toLocaleString()}幣`);
        if (seedUses === 0 && totalCost === 0) parts.push("免費");
        parts.push(`${hours}h成熟`);
        if (def.seedKey && !def.seedOptional) {
          parts.push(`種子${seedQty >= emptyCount ? "✅" : "⚠️"}${seedQty}`);
        }
        if (coins < totalCost) parts.push("幣不足全部");
        return {
          label: def.name,
          value: key,
          description: parts.join("・").slice(0, 100),
          emoji: def.emoji,
        };
      });

      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 🌱 一鍵種植 ${emptyCount} 塊空地`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(summary))
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`farm_plantallsel_${userId}`)
              .setPlaceholder("選擇要種植的作物…")
              .addOptions(options),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 金幣或種子不夠時，會盡量種到不夠為止"),
        );
      return replyEphemeralContainer(interaction, c);
    }

    // ── plantallsel：實際在所有空地種下選定作物 ──
    if (action === "plantallsel" && isSelect) {
      const cropKey = interaction.values?.[0];
      if (!cropKey) return;
      await interaction.deferReply();

      const result = await farmService.plantAllCrops(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        cropKey,
      });

      if (!result.ok) {
        if (result.reason === "no_empty_plot") {
          return replyEphemeralContainer(
            interaction,
            errContainer("🌾 沒有空地", "目前所有地塊都已種植或被入侵。", "等收成後再來"),
          );
        }
        if (result.reason === "missing_seed") {
          const seedKey = result.stopReason?.seedKey;
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 需要稀有種子", `種植 **黑玫瑰** 需要 \`${seedKey}\` ×1。`, "黑玫瑰種子只能從地下城（Lv 30+）掉落"),
          );
        }
        if (result.reason === "insufficient_coins") {
          const need = result.stopReason?.need;
          const have = result.stopReason?.have;
          return replyEphemeralContainer(
            interaction,
            errContainer("❌ 金幣不足", `第一塊地就種不起：需要 **${need}** 幣，目前 **${have}** 幣。`, "去 /打工、/挖礦 賺點本錢"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 種植失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }

      const cropDef = result.crop;
      const earliestReady = Math.min(...result.planted.map((p) => p.ready_at));
      const costParts = [];
      if (result.totalSeedsUsed > 0) costParts.push(`🌱 ${cropDef.emoji} 種子 ×${result.totalSeedsUsed}`);
      if (result.totalCoinsPaid > 0) costParts.push(`${result.totalCoinsPaid.toLocaleString()} 幣`);
      const costLine = costParts.join(" + ") || "免費";
      const lines = [
        `🌾 ${cropDef.emoji} **${cropDef.name}** ×${result.planted.length}`,
        `💸 總花費：${costLine}`,
        `🌟 最早成熟：<t:${Math.floor(earliestReady / 1000)}:R>`,
      ];
      if (result.stopReason) {
        const remain = result.totalTargets - result.planted.length;
        if (result.stopReason.reason === "insufficient_coins") {
          lines.push(`-# ⚠️ 金幣不夠，剩 ${remain} 塊地未種`);
        } else if (result.stopReason.reason === "missing_seed") {
          lines.push(`-# ⚠️ 種子不夠，剩 ${remain} 塊地未種`);
        }
      }
      const c = buildSuccessContainer("🌱 一鍵種植完成", lines.join("\n"), interaction.user.id, 0x4a90a4);
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtPlantAll = await farmService.getNextReadyAt(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtPlantAll,
      }).catch(() => {});

      const hooks = result.planted.map(() => ({ questId: "daily_farm_plant" }));
      applyQuestHooks(client, ctxOf(interaction), hooks).catch(() => {});
      return;
    }

    // ── fert 按鈕：彈出肥料選單 ──
    if (action === "fert" && isBtn) {
      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const inv = fertilizerInventoryLine(profile);
      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 💧 選擇要施在地塊 ${plotIndex + 1} 的肥料`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`你目前的材料：\n${inv}`),
        )
        .addActionRowComponents(buildFertilizerSelector(interaction.user.id, plotIndex, { profile }))
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "-# 此處每次施一份。要批量施肥請用施肥後的「再施 N 份」按鈕",
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
            errContainer("❌ 材料不足", `${src}「${fertDef.name || result.key}」需要 **${result.need}**，目前 **${result.have}**。`, "去 /挖礦、/釣魚、/地下城、/烹飪 收集"),
          );
        }
        if (result.reason === "growth_cap_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("⛔ 已達加速上限", `這塊地的成長時間已縮短到上限（${Math.round((farming.growthReductionCapPct || 0.6) * 100)}%）。`, "改施提升收成上限的肥料（章魚／月光露水）"),
          );
        }
        if (result.reason === "yield_cap_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("⛔ 已達收成加成上限", `這塊地的施肥收成加成已達上限（+${Math.round((result.yieldCap ?? farming.yieldBonusCapPct ?? 2) * 100)}%，目前 +${Math.round((result.currentYield || 0) * 100)}%）。再施 ${fertDef.emoji || ""} **${fertDef.name || fertilizerKey}** 不會再增加收成，已自動擋下、沒有扣材料。`, "直接收成這塊地，或把肥料留給其他地塊"),
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
            errContainer("🌟 已可收成", "這塊地的作物已成熟，無需施肥。", "直接點該地塊的「收成」按鈕即可"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 施肥失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }

      const c = await buildFertSuccessContainer(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        plotIndex,
        fertilizerKey,
        result: { ...result, requestedCount: 1 },
      });
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtFert = await farmService.getNextReadyAt(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtFert,
      }).catch(() => {});
      return;
    }

    // ── fertagain：對同地塊再施 N 份（payload: <plotIndex>_<fertKey>_<count>）──
    if (action === "fertagain" && isBtn) {
      const segs = (payload || "").split("_");
      if (segs.length < 3) return;
      const againPlotIndex = Number.parseInt(segs[0], 10);
      const countSpec = segs[segs.length - 1];
      const fertilizerKey = segs.slice(1, -1).join("_");
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};
      await interaction.deferReply();

      const profile = await getOrCreate(client, interaction.user.id, interaction.guildId);
      const sourceField = fertDef.source === "fish_bag" ? "fish_bag" : "backpack";
      const have = (profile[sourceField] || {})[fertDef.key] || 0;
      const perPlot = fertDef.qty || 1;
      const materialMax = Math.floor(have / perPlot);
      const requested = countSpec === "max" ? materialMax : Number.parseInt(countSpec, 10);
      const count = Math.min(Math.max(1, requested || 0), materialMax);

      if (count <= 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("❌ 材料不足", `${sourceField === "fish_bag" ? "魚袋" : "背包"}「${fertDef.name}」需要 **${perPlot}**，目前 **${have}**。`, "去 /挖礦、/釣魚、/地下城、/烹飪 收集"),
        );
      }

      const result = await farmService.fertilize(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        plotIndex: againPlotIndex, fertilizerKey, count,
      });

      if (!result.ok) {
        if (result.reason === "growth_cap_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("⛔ 已達加速上限", `這塊地的成長時間已縮短到上限（${Math.round((farming.growthReductionCapPct || 0.6) * 100)}%）。`, "改施提升收成上限的肥料（章魚／月光露水）"),
          );
        }
        if (result.reason === "yield_cap_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("⛔ 已達收成加成上限", `這塊地的施肥收成加成已達上限（+${Math.round((result.yieldCap ?? farming.yieldBonusCapPct ?? 2) * 100)}%，目前 +${Math.round((result.currentYield || 0) * 100)}%）。再施 ${fertDef.emoji || ""} **${fertDef.name || fertilizerKey}** 不會再增加收成，已自動擋下、沒有扣材料。`, "直接收成這塊地，或把肥料留給其他地塊"),
          );
        }
        if (result.reason === "already_ready") {
          return replyEphemeralContainer(
            interaction,
            errContainer("🌟 已可收成", "這塊地的作物已成熟，無需施肥。", "直接點該地塊的「收成」按鈕即可"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 施肥失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }

      const c = await buildFertSuccessContainer(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        plotIndex: againPlotIndex,
        fertilizerKey,
        result: { ...result, requestedCount: count },
      });
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtAgain = await farmService.getNextReadyAt(
        client, interaction.user.id, interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtAgain,
      }).catch(() => {});
      return;
    }

    // ── fertrest：對其他成長中地塊各施 1 份（payload: <plotIndex>_<fertKey>）──
    if (action === "fertrest" && isBtn) {
      const segs = (payload || "").split("_");
      if (segs.length < 2) return;
      const excludePlotIndex = Number.parseInt(segs[0], 10);
      const fertilizerKey = segs.slice(1).join("_");
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};
      await interaction.deferReply();

      const result = await farmService.fertilizeAll(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        fertilizerKey,
        excludePlotIndex,
      });

      if (!result.ok) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🌱 沒有可施肥的地塊", "其他成長中的地塊不適用此肥料、或都已達加速／收成上限。", "改用其他肥料試試"),
        );
      }

      const fertSourceLabel = fertDef.source === "fish_bag" ? "魚袋" : "背包";
      const totalConsumed = result.applied.reduce((s, a) => s + (a.consumed || 0), 0);
      const lines = [
        `💧 ${fertDef.emoji} **${fertDef.name}** 對其他 **${result.applied.length}** 塊地各施 1 份`,
        `🧪 共消耗：${fertSourceLabel}「${fertDef.name}」 ×${totalConsumed}`,
      ];
      if (result.stoppedByMaterial) lines.push("-# ⚠️ 材料用完，剩餘地塊未施");
      const skipLine = skippedSummaryLine(result.skipped);
      if (skipLine) lines.push(skipLine);

      const c = buildSuccessContainer("💧 一鍵施肥（其餘）完成", lines.join("\n"), interaction.user.id, 0x4a90a4);
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtRest = await farmService.getNextReadyAt(
        client, interaction.user.id, interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtRest,
      }).catch(() => {});
      return;
    }

    // ── fertall 按鈕：彈出肥料 select（一鍵施肥）──
    if (action === "fertall" && isBtn) {
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profile = await getOrCreate(client, userId, guildId);
      const plotCount = farmService.getPlotCount(profile);
      const plots = await farmService.getPlots(client, userId, guildId, plotCount);
      const growingCount = plots.filter((p) => {
        const live = farmService.resolveLiveStatus(p);
        return live.crop && live.status === "growing";
      }).length;

      if (growingCount === 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🌱 沒有成長中的地塊", "目前沒有任何正在成長的作物可以施肥。", "等收成完再種點什麼"),
        );
      }

      const options = Object.entries(farming.fertilizers || {}).map(([key, def]) => {
        const sourceField = def.source === "fish_bag" ? "fish_bag" : "backpack";
        const sourceLabel = def.source === "fish_bag" ? "魚袋" : "背包";
        const have = (profile[sourceField] || {})[def.key] || 0;
        const perPlot = def.qty || 1;
        const canApply = Math.floor(have / perPlot);
        const effects = [];
        if (def.growReductionPct) effects.push(`-${Math.round(def.growReductionPct * 100)}%成長`);
        if (def.yieldBonusPct) effects.push(`+${Math.round(def.yieldBonusPct * 100)}%收成`);
        const parts = [
          `${sourceLabel}${have}`,
          `夠施${Math.min(canApply, growingCount)}/${growingCount}塊`,
          effects.join("／"),
        ];
        if (Array.isArray(def.onlyCrops)) parts.push("限部分作物");
        return {
          label: def.name,
          value: key,
          description: parts.join("・").slice(0, 100),
          emoji: def.emoji,
        };
      });

      const c = new ContainerBuilder()
        .setAccentColor(0x4a90a4)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`# 💧 一鍵施肥（${growingCount} 塊成長中地塊）`),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`你目前的材料：\n${fertilizerInventoryLine(profile)}`),
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`farm_fertallsel_${userId}`)
              .setPlaceholder("選擇要施的肥料…")
              .addOptions(options),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 每塊地各施 1 份；確認後才會扣材料"),
        );
      return replyEphemeralContainer(interaction, c);
    }

    // ── fertallsel：選了肥料 → 顯示預覽確認 ──
    if (action === "fertallsel" && isSelect) {
      const fertilizerKey = interaction.values?.[0];
      if (!fertilizerKey) return;
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};
      const userId = interaction.user.id;
      const guildId = interaction.guildId;

      const preview = await farmService.previewFertilizeAll(client, { userId, guildId, fertilizerKey });
      if (!preview.ok) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 預覽失敗", `原因：\`${preview.reason}\``, "請稍後再試"),
        );
      }

      const sourceLabel = preview.sourceField === "fish_bag" ? "魚袋" : "背包";
      if (preview.willApply <= 0) {
        const body = preview.eligibleCount === 0
          ? "目前沒有任何能用這種肥料的成長中地塊（可能都不適用、或已達加速／收成上限）。"
          : `需要 ${sourceLabel}「${fertDef.name}」**${preview.eligibleCount * preview.perPlot}**，目前 **${preview.have}**。`;
        return replyEphemeralContainer(
          interaction,
          errContainer("❌ 無法施肥", body, "改用其他肥料或先收集材料"),
        );
      }

      const lines = [
        `🌾 將對 **${preview.willApply}** 塊成長中地塊各施 1 份 ${fertDef.emoji} **${fertDef.name}**`,
        `🧪 消耗 ${sourceLabel}「${fertDef.name}」 **${preview.willConsume}**（庫存 ${preview.have} → ${preview.have - preview.willConsume}）`,
      ];
      if (fertDef.growReductionPct) lines.push(`⏱️ 每塊成長 -${Math.round(fertDef.growReductionPct * 100)}%（封頂 ${Math.round((farming.growthReductionCapPct || 0.6) * 100)}%）`);
      if (fertDef.yieldBonusPct) lines.push(`🌟 每塊 +${Math.round(fertDef.yieldBonusPct * 100)}% 收成（封頂 +${Math.round((farming.yieldBonusCapPct ?? 2) * 100)}%）`);
      if (preview.materialShort) lines.push(`-# ⚠️ 材料只夠 ${preview.willApply}/${preview.eligibleCount} 塊`);
      const skipLine = skippedSummaryLine(preview.skipped);
      if (skipLine) lines.push(skipLine);

      const c = new ContainerBuilder()
        .setAccentColor(0xf1c40f)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 💧 確認一鍵施肥？"),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`farm_fertallcfm_${userId}_${fertilizerKey}`)
              .setLabel(`確認施肥（${preview.willApply} 塊）`)
              .setEmoji("💧")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`farm_fertallcancel_${userId}`)
              .setLabel("取消")
              .setStyle(ButtonStyle.Secondary),
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# 按下「確認施肥」後才會扣材料"),
        );
      return replyEphemeralContainer(interaction, c);
    }

    // ── fertallcancel：取消一鍵施肥 ──
    if (action === "fertallcancel") {
      const c = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("# 已取消一鍵施肥"))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("沒有扣材料，地塊維持原狀。"));
      return interaction.update({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── fertallcfm：確認後執行一鍵施肥（payload: <fertKey>）──
    if (action === "fertallcfm" && isBtn) {
      const fertilizerKey = payload;
      const fertDef = farming.fertilizers?.[fertilizerKey] || {};
      await interaction.deferReply();

      const result = await farmService.fertilizeAll(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        fertilizerKey,
      });

      if (!result.ok) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🌱 沒有可施肥的地塊", "成長中地塊不適用此肥料、或都已達加速／收成上限。", "改用其他肥料試試"),
        );
      }

      const sourceLabel = fertDef.source === "fish_bag" ? "魚袋" : "背包";
      const totalConsumed = result.applied.reduce((s, a) => s + (a.consumed || 0), 0);
      const totalReductionMs = result.applied.reduce((s, a) => s + (a.reductionMs || 0), 0);
      const avgMin = result.applied.length > 0 ? Math.round(totalReductionMs / result.applied.length / 60000) : 0;
      const lines = [
        `💧 ${fertDef.emoji} **${fertDef.name}** 對 **${result.applied.length}** 塊地各施 1 份`,
        `🧪 共消耗：${sourceLabel}「${fertDef.name}」 ×${totalConsumed}`,
      ];
      if (avgMin > 0) lines.push(`⏱️ 平均每塊成長 -${avgMin} 分鐘`);
      if (result.stoppedByMaterial) lines.push("-# ⚠️ 材料用完，剩餘地塊未施");
      const skipLine = skippedSummaryLine(result.skipped);
      if (skipLine) lines.push(skipLine);

      const c = buildSuccessContainer("💧 一鍵施肥完成", lines.join("\n"), interaction.user.id, 0x4a90a4);
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const nextReadyAtAll = await farmService.getNextReadyAt(
        client, interaction.user.id, interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtAll,
      }).catch(() => {});
      return;
    }

    // ── harvestall：一鍵收成所有成熟地塊 ──
    if (action === "harvestall") {
      await interaction.deferReply();
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const profile = await getOrCreate(client, userId, guildId);
      const plotCount = farmService.getPlotCount(profile);
      const plots = await farmService.getPlots(client, userId, guildId, plotCount);
      const readyPlots = plots
        .map((p) => farmService.resolveLiveStatus(p))
        .filter((p) => p.status === "ready");

      if (readyPlots.length === 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🌱 沒有可收成的地塊", "目前沒有任何成熟的作物。", "等成熟後再回來"),
        );
      }

      const results = [];
      for (const p of readyPlots) {
        const r = await farmService.harvestCrop(client, {
          userId, guildId,
          username: interaction.user.username,
          member: interaction.member,
          plotIndex: p.plotIndex,
        });
        if (r.ok) results.push(r);
      }

      if (results.length === 0) {
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 收成失敗", "所有可收成的地塊都收成失敗了。", "請呼叫舒舒！"),
        );
      }

      const cropAgg = new Map();
      let totalCoins = 0;
      let totalWorldBonus = 0;
      const bonusAgg = new Map();
      for (const r of results) {
        totalCoins += r.coins || 0;
        totalWorldBonus += r.worldYieldCountBonus || 0;
        const entry = cropAgg.get(r.crop) || { def: r.cropDef, count: 0, coins: 0 };
        entry.count += r.harvestCount || 1;
        entry.coins += r.coins || 0;
        cropAgg.set(r.crop, entry);
        for (const d of r.bonusDrops || []) {
          bonusAgg.set(d.kind, (bonusAgg.get(d.kind) || 0) + d.amount);
        }
      }

      const cropLines = [...cropAgg.values()].map(
        (e) => `${e.def.emoji} **${e.def.name}** ×${e.count}（+${e.coins.toLocaleString()} 幣）`,
      );
      if (totalWorldBonus > 0) {
        cropLines.push(`-# 含世界事件額外產出 +${totalWorldBonus} 個`);
      }
      const bonusLines = [];
      if (bonusAgg.get("fragment")) bonusLines.push(`✨ 傳說碎片 ×${bonusAgg.get("fragment")}`);
      if (bonusAgg.get("rare_bait")) bonusLines.push(`✨ 稀有魚餌 ×${bonusAgg.get("rare_bait")}`);

      const body = [
        `🌾 收成 **${results.length}** 塊地`,
        ...cropLines,
        `💰 總收益：**+${totalCoins.toLocaleString()} 幣**`,
        ...bonusLines,
      ].join("\n");
      const c = buildSuccessContainer("🌟 一鍵收成完成", body, userId);

      const hooks = [];
      for (const r of results) {
        hooks.push({ questId: "daily_farm_harvest" });
        hooks.push({ questId: "weekly_farm_harvest" });
        if (r.crop === "black_rose") hooks.push({ questId: "weekly_farm_rose" });
      }
      applyQuestHooks(client, ctxOf(interaction), hooks).catch(() => {});

      for (const r of results) {
        const note = buildHarvestAnnouncement({ user: interaction.user, result: r });
        if (note) {
          sendFarmAnnouncement(client, interaction.channel, note).catch(() => {});
        }
      }

      const nextReadyAtHarvestAll = await farmService.getNextReadyAt(client, userId, guildId);
      reminder.refreshIfEnabled(client, {
        userId, guildId, type: "farm", readyAt: nextReadyAtHarvestAll,
      }).catch(() => {});

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
          not_ready: ["⏱️ 還沒成熟", "作物還在成長中。", "點地塊下方「施肥」按鈕加速"],
          empty_plot: ["❌ 空地塊", `地塊 ${plotIndex + 1} 沒種任何東西。`, "點空地塊下方「種植」按鈕種點什麼"],
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
        `🌾 **${def.emoji} ${def.name}** ×${result.harvestCount}` +
          (result.worldYieldCountBonus > 0
            ? `（含世界事件 +${result.worldYieldCountBonus} 個）`
            : ""),
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

      const harvestNote = buildHarvestAnnouncement({ user: interaction.user, result });
      if (harvestNote) {
        sendFarmAnnouncement(client, interaction.channel, harvestNote).catch(() => {});
      }

      const nextReadyAtHarvest = await farmService.getNextReadyAt(
        client,
        interaction.user.id,
        interaction.guildId,
      );
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: nextReadyAtHarvest,
      }).catch(() => {});

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
          no_stamina: ["🔋 體力不足", "防禦需要 1 點地下城體力。", "等體力回復或用精力藥水"],
          no_weapon: ["🗡️ 沒有武器", "防禦怪物需要持有武器。", "去 /合成 打造一把劍"],
        };
        const [t, b, h] = map[result.reason] || ["🔧 防禦失敗", `原因：\`${result.reason}\``, ""];
        return replyEphemeralContainer(interaction, errContainer(t, b, h));
      }
      const monster = result.monster;
      const lines = result.won
        ? [
            `⚔️ 擊退了 **${monster.monsterEmoji} ${monster.monsterName}**！`,
            `💰 戰利品：+${result.coinsGained} 幣${result.slimeGained > 0 ? `、💧 黏液 ×${result.slimeGained}` : ""}${result.droppedTrapFragment ? `、🪛 損壞的陷阱碎片 ×1` : ""}`,
            `🌟 作物保住了，可立即點「收成」`,
          ]
        : [
            `💀 被 **${monster.monsterEmoji} ${monster.monsterName}** 擊敗，作物被毀！`,
            `下次更早回來收成吧 🥲`,
          ];
      if (result.won && result.droppedTrapFragment) {
        lines.push(`-# 集 5 個損壞的陷阱碎片可在工坊合成「高級陷阱」，被動抵擋 4 次來犯`);
      }
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

      const defendNote = buildDefendAnnouncement({ user: interaction.user, result });
      if (defendNote) {
        sendFarmAnnouncement(client, interaction.channel, defendNote).catch(() => {});
      }

      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── trap：沒體力時的備案，30% 賭機率救作物 ──
    if (action === "trap") {
      await interaction.deferReply();
      const result = await farmService.setTrap(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        username: interaction.user.username,
        member: interaction.member,
        plotIndex,
      });
      if (!result.ok) {
        const map = {
          no_raid: ["⚠️ 沒有入侵中", "這塊地沒有怪物正在侵擾。", "回主畫面重新整理狀態"],
        };
        const [t, b, h] = map[result.reason] || ["🔧 擺陷阱失敗", `原因：\`${result.reason}\``, ""];
        return replyEphemeralContainer(interaction, errContainer(t, b, h));
      }
      const monster = result.monster;
      const lines = result.won
        ? [
            `🪤 陷阱成功！**${monster.monsterEmoji} ${monster.monsterName}** 落荒而逃。`,
            result.coinsGained > 0 ? `💰 撿到 **+${result.coinsGained} 幣**` : null,
            `🌱 作物保住了`,
          ].filter(Boolean)
        : [
            `💀 陷阱失靈，**${monster.monsterEmoji} ${monster.monsterName}** 把作物啃光了…`,
            result.flavor ? `-# ${result.flavor}` : null,
            `-# 想穩一點就乖乖等體力回復用「防禦」`,
          ].filter(Boolean);
      const c = buildSuccessContainer(
        result.won ? "🪤 陷阱奏效" : "🪤 陷阱失靈",
        lines.join("\n"),
        interaction.user.id,
        result.won ? 0x2ecc71 : 0xe74c3c,
      );

      const trapNote = buildTrapAnnouncement({ user: interaction.user, result });
      if (trapNote) {
        sendFarmAnnouncement(client, interaction.channel, trapNote).catch(() => {});
      }

      return interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── expand：先顯示擴建預覽與確認按鈕（不直接扣款）──
    if (action === "expand") {
      const preview = await farmService.previewExpand(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      if (!preview.ok) {
        if (preview.reason === "max_reached") {
          return replyEphemeralContainer(
            interaction,
            errContainer("🏆 已達上限", `農場已擴建到 **${preview.current}** 格，無法再擴展。`, ""),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 擴建失敗", `原因：\`${preview.reason}\``, "請稍後再試"),
        );
      }
      if (!preview.canAfford) {
        return replyEphemeralContainer(
          interaction,
          errContainer(
            "❌ 金幣不足",
            `擴建 **${preview.current} → ${preview.nextCount}** 格需要 **${preview.cost.toLocaleString()}** 幣，目前 **${preview.have.toLocaleString()}** 幣（還差 ${(preview.cost - preview.have).toLocaleString()}）。`,
            "去賺點本錢再回來",
          ),
        );
      }
      const confirmContainer = new ContainerBuilder()
        .setAccentColor(0xf1c40f)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🏗️ 確認擴建農場？"),
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
      return replyEphemeralContainer(interaction, confirmContainer);
    }

    // ── expandcancel：取消擴建確認 ──
    if (action === "expandcancel") {
      const c = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 已取消擴建"),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("沒有扣款，農場保持原狀。"),
        );
      return interaction.update({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ── expandconfirm：實際執行擴建 ──
    if (action === "expandconfirm") {
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
            errContainer("❌ 金幣不足", `擴建到 **${result.nextCount}** 格需要 **${result.need.toLocaleString()}** 幣，目前 **${result.have.toLocaleString()}** 幣。`, "去賺點本錢再回來"),
          );
        }
        return replyEphemeralContainer(
          interaction,
          errContainer("🔧 擴建失敗", `原因：\`${result.reason}\``, "請稍後再試"),
        );
      }
      const c = buildSuccessContainer(
        "🏗️ 農場擴建成功",
        `📈 地塊 **${result.from} → ${result.to}** 格\n💸 花費：${result.cost.toLocaleString()} 幣`,
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
      if (!def) {
        return replyEphemeralContainer(
          interaction,
          errContainer("❌ 無法賣出", "找不到這種農產品。", ""),
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
      const cropMarket = await orePriceEngine.getDailyCropPrices(client).catch(() => ({ prices: {} }));
      const price = typeof cropMarket.prices?.[cropKey] === "number"
        ? cropMarket.prices[cropKey]
        : orePriceEngine.cropBasePrice(cropKey);
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
