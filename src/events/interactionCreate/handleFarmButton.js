// 農場系統按鈕／選單處理器（Phase D）
//
// Button customId：
//   farm_plant_<ownerId>_<plotIndex>    — 開啟作物選單（StringSelect）
//   farm_harvest_<ownerId>_<plotIndex>  — 直接收成該地塊
//   farm_fert_<ownerId>_<plotIndex>     — 開啟肥料選單（StringSelect）
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
const {
  sendFarmAnnouncement,
  buildHarvestAnnouncement,
  buildDefendAnnouncement,
  buildTrapAnnouncement,
} = require("../../features/farm/farmAnnouncer");
const { resolveStamina, staminaMax } = require("../../features/mining/dungeonService");
const reminder = require("../../features/reminders/cooldownReminderService");

const BTN_PREFIXES = [
  "farm_plant_", "farm_harvestall_", "farm_harvest_", "farm_fert_", "farm_defend_", "farm_trap_",
  "farm_expandconfirm_", "farm_expandcancel_", "farm_expand_",
  "farm_view_", "farm_sell_",
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
        userId, guildId, plotIndex: p.plotIndex, fromStatus: p.status,
      });
      if (raid) {
        p.status = "raided";
        p.raid = raid;
      }
    }
  }
  const sMax = staminaMax(interaction.member);
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
    const parts = [`${def.plantCost}幣`, `${hours}h 成熟`];
    if (def.seedKey) {
      const seedQty = profile?.seed_bag?.[def.seedKey] || 0;
      parts.push(`種子${seedQty >= 1 ? "✅" : "❌"}${seedQty}`);
    }
    if (typeof coins === "number" && coins < def.plantCost) parts.push("幣不足");
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

// 提供「施肥」select menu（每次施 1 份；想要批量請用 /施肥 次數）
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

      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: result.plot.ready_at,
      }).catch(() => {});

      applyQuestHooks(client, ctxOf(interaction), [{ questId: "daily_farm_plant" }]).catch(() => {});
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
      await interaction.editReply({
        components: [c],
        flags: MessageFlags.IsComponentsV2,
      });

      const earliest = await client.farmPlotsCollection
        ?.findOne(
          { userId: interaction.user.id, guildId: interaction.guildId, status: "growing" },
          { sort: { ready_at: 1 }, projection: { ready_at: 1 } },
        )
        .catch(() => null);
      reminder.refreshIfEnabled(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        type: "farm",
        readyAt: earliest?.ready_at || 0,
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
      const bonusAgg = new Map();
      for (const r of results) {
        totalCoins += r.coins || 0;
        const entry = cropAgg.get(r.crop) || { def: r.cropDef, count: 0, coins: 0 };
        entry.count += 1;
        entry.coins += r.coins || 0;
        cropAgg.set(r.crop, entry);
        for (const d of r.bonusDrops || []) {
          bonusAgg.set(d.kind, (bonusAgg.get(d.kind) || 0) + d.amount);
        }
      }

      const cropLines = [...cropAgg.values()].map(
        (e) => `${e.def.emoji} **${e.def.name}** ×${e.count}（+${e.coins.toLocaleString()} 幣）`,
      );
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

      const harvestNote = buildHarvestAnnouncement({ user: interaction.user, result });
      if (harvestNote) {
        sendFarmAnnouncement(client, interaction.channel, harvestNote).catch(() => {});
      }

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
