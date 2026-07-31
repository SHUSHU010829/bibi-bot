// 公會擴張面板：熔爐 / 精煉站 / 建築 統一視圖
// 元件預算：每個 view ≤ 35 元件，使用 Select Menu 收斂配方/建築選擇
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const { guildForge, guildBuildings, guildWarehouse, guildBanquet } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const guildClubService = require("./guildClubService");
const forgeService = require("./forgeService");
const buildingService = require("./buildingService");
const banquetService = require("./banquetService");

const COLOR_GOLD = 0xf1c40f;
const COLOR_ERROR = 0xe74c3c;
const COLOR_SUCCESS = 0x2ecc71;
const COLOR_INFO = 0x3498db;

const itemLabel = (id) => guildWarehouse?.items?.[id]?.name || id;
const itemEmoji = (id) => guildWarehouse?.items?.[id]?.emoji || "📦";

const formatCost = (cost) => {
  const out = [];
  for (const [k, v] of Object.entries(cost || {})) {
    if (k === "coins") out.push(`${v.toLocaleString()} ${COIN_EMOJI}`);
    else out.push(`${itemEmoji(k)} ${itemLabel(k)} ×${v}`);
  }
  return out.join("・");
};

const formatBuffList = (buffs) => {
  const { formatBuff } = require("../buff/buffLabels");
  return (buffs || []).map((b) => formatBuff(b.type, b.value)).join("・");
};

// ───────────────────── 熔爐主面板 ─────────────────────
function buildForgePanel({ viewerId, club, warehouseRows, isManager }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  const forgeLv = guildClubService.forgeLevelOf(club);
  const refineryLv = guildClubService.refineryLevelOf(club);
  const forgeCfg = guildForge.forge;
  const refineryCfg = guildForge.refinery;
  const discount = forgeService.discountPctFor(refineryLv);

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🔥 ${club.name} 熔爐\n` +
        `熔爐 Lv.${forgeLv}/${forgeCfg.maxLevel}　・　精煉站 Lv.${refineryLv}/${refineryCfg.maxLevel}${
          discount > 0 ? `（消耗 -${discount}%）` : ""
        }\n` +
        `公會資金：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`
    )
  );

  c.addSeparatorComponents(new SeparatorBuilder());

  // 條件未滿
  if ((club.level || 1) < forgeCfg.unlockClubLevel) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔒 熔爐尚未解鎖\n` +
          `解鎖條件：公會等級 ${forgeCfg.unlockClubLevel}\n` +
          `目前：Lv.${club.level || 1}\n` +
          `-# 持續累積公會貢獻提升公會等級即可開啟熔爐。`
      )
    );
    return c;
  }

  // 已達等級但尚未蓋熔爐
  if (forgeLv === 0) {
    const next = forgeService.upgradeForgeRow(0);
    const canPay = (club.treasury_current || 0) >= next.cost;
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🛠️ 熔爐尚未建造\n` +
          `首次建造費用：${next.cost.toLocaleString()} ${COIN_EMOJI}（解鎖建材配方）\n` +
          `-# ${isManager ? "點下方按鈕由會長 / 副會長啟動建造。" : "需會長 / 副會長啟動建造。"}`
      )
    );
    if (isManager) {
      c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gcx_forge_up|${viewerId}|${club.guild_club_id}`)
            .setLabel(canPay ? `建造熔爐（-${next.cost.toLocaleString()}）` : `公會資金不足`)
            .setEmoji("🛠️")
            .setStyle(canPay ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!canPay)
        )
      );
    }
    return c;
  }

  // 列配方 + Select 選製造
  const recipeKeys = Object.keys(forgeCfg.recipes);
  const wh = {};
  for (const r of warehouseRows || []) wh[r.item_id] = r.available_qty || 0;

  const options = [];
  for (const key of recipeKeys) {
    const recipe = forgeCfg.recipes[key];
    const locked = forgeLv < (recipe.requiresForgeLevel || 1);
    const inputs = forgeService.getEffectiveInputs(key, refineryLv);
    const inputText = Object.entries(inputs)
      .map(([k, v]) => `${itemLabel(k)}×${v}`)
      .join(" + ");
    const lackLines = [];
    for (const [k, v] of Object.entries(inputs)) {
      if ((wh[k] || 0) < v) lackLines.push(`${itemLabel(k)}缺 ${v - (wh[k] || 0)}`);
    }
    const status = locked
      ? `🔒 熔爐 Lv.${recipe.requiresForgeLevel} 解鎖`
      : lackLines.length > 0
      ? `料不夠：${lackLines.join("・")}`
      : `可製造`;
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${itemEmoji(key)} **${recipe.label}**（×${recipe.output}）\n` +
          `素材：${inputText}\n` +
          `-# ${status}`
      )
    );
    if (!locked) {
      options.push(
        new StringSelectMenuOptionBuilder()
          .setLabel(`${recipe.label} ×${recipe.output}（${inputText}）`)
          .setValue(key)
          .setEmoji(itemEmoji(key))
          .setDescription(
            lackLines.length === 0 ? "公會倉庫材料足夠" : lackLines.join("・")
          )
      );
    }
  }

  c.addSeparatorComponents(new SeparatorBuilder());

  if (options.length > 0) {
    c.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gcx_forge_pick|${viewerId}|${club.guild_club_id}`)
          .setPlaceholder("選擇要製造的物品")
          .addOptions(options)
      )
    );
  }

  // 會長 / 副會長：升級熔爐 / 精煉站按鈕
  if (isManager) {
    const row = new ActionRowBuilder();
    const nextForge = forgeService.upgradeForgeRow(forgeLv);
    if (nextForge) {
      const canPay = (club.treasury_current || 0) >= nextForge.cost;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`gcx_forge_up|${viewerId}|${club.guild_club_id}`)
          .setLabel(`升級熔爐至 Lv.${nextForge.toLevel}（${nextForge.cost.toLocaleString()} 幣）`)
          .setEmoji("🔥")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!canPay)
      );
    }
    if ((club.level || 1) >= refineryCfg.unlockClubLevel) {
      const nextRef = forgeService.upgradeRefineryRow(refineryLv);
      if (nextRef) {
        const canPay = (club.treasury_current || 0) >= nextRef.cost;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`gcx_refinery_up|${viewerId}|${club.guild_club_id}`)
            .setLabel(`升級精煉站至 Lv.${nextRef.toLevel}（${nextRef.cost.toLocaleString()} 幣）`)
            .setEmoji("⚗️")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!canPay)
        );
      }
    }
    // 高階精煉站除了金庫還要材料，按鈕 label 塞不下，另外印一行
    const nextRefMats = forgeService.upgradeRefineryRow(refineryLv)?.materials;
    if (nextRefMats && Object.keys(nextRefMats).length > 0) {
      const line = Object.entries(nextRefMats)
        .map(([id, qty]) => {
          const meta = guildWarehouse?.items?.[id];
          return `${meta?.emoji || ""} ${meta?.name || id} ×${qty}`.trim();
        })
        .join("・");
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# 精煉站下一級另需公會倉庫材料：${line}`)
      );
    }
    if (row.components.length > 0) c.addActionRowComponents(row);
  } else if ((club.level || 1) >= refineryCfg.unlockClubLevel && refineryLv < refineryCfg.maxLevel) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 升級熔爐 / 精煉站須由會長 / 副會長操作。`)
    );
  }

  return c;
}

// ───────────────────── 製造數量選擇 ─────────────────────
function buildForgeQtyPanel({ viewerId, club, recipeKey, maxQty }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  const recipe = guildForge.forge.recipes[recipeKey];
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${itemEmoji(recipeKey)} 製造 ${recipe.label}\n以公會倉庫的素材生產，產出物入公會倉庫。`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  if (maxQty <= 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ❌ 材料不足\n公會倉庫目前無法製造任何數量。\n-# 提示：先用 \`/公會 存入\` 把礦石搬進倉庫。`
      )
    );
    return c;
  }
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`目前公會倉庫最多可造 ×${maxQty}`)
  );
  const choices = [1, 10, Math.min(maxQty, 50), Math.min(maxQty, 100), maxQty]
    .filter((v, i, arr) => v > 0 && v <= maxQty && arr.indexOf(v) === i);
  const row = new ActionRowBuilder();
  for (const q of choices.slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_forge_make|${viewerId}|${club.guild_club_id}|${recipeKey}|${q}`)
        .setLabel(`製造 ×${q}`)
        .setStyle(q === maxQty ? ButtonStyle.Success : ButtonStyle.Primary)
    );
  }
  c.addActionRowComponents(row);
  return c;
}

// ───────────────────── 建築面板 ─────────────────────
function buildBuildingsPanel({ viewerId, club, warehouseRows, isManager }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  const bl = guildClubService.buildingsOf(club);
  const minUnlock = Math.min(
    ...buildingService.allKinds().map((k) => buildingService.unlockClubLevelOf(k))
  );

  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🏗️ ${club.name} 公會建築\n` +
        `公會 Lv.${club.level || 1}　・　公會資金：${(club.treasury_current || 0).toLocaleString()} ${COIN_EMOJI}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());

  if ((club.level || 1) < minUnlock) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🔒 公會建築尚未解鎖\n解鎖條件：公會等級 ${minUnlock}\n目前：Lv.${club.level || 1}`
      )
    );
    return c;
  }

  const wh = {};
  for (const r of warehouseRows || []) wh[r.item_id] = r.available_qty || 0;

  const upgradeRows = [];
  for (const kind of buildingService.allKinds()) {
    const def = buildingService.kindDef(kind);
    const unlockNeed = buildingService.unlockClubLevelOf(kind);
    const lv = bl[kind] || 0;

    const lines = [`${def.emoji} **${def.label}**　Lv.${lv}/${def.maxLevel}`];

    if ((club.level || 1) < unlockNeed) {
      lines.push(`-# 🔒 公會 Lv.${unlockNeed} 解鎖（目前 Lv.${club.level || 1}）`);
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
      continue;
    }

    const current = buildingService.levelRow(kind, lv);
    const next = buildingService.nextLevelRow(kind, lv);

    if (current) {
      if (current.buffs)
        lines.push(`-# 當前效果：${formatBuffList(current.buffs)}`);
      if (current.capacity_bonus)
        lines.push(`-# 當前倉庫容量：每物品 +${current.capacity_bonus}（累計）`);
    }
    if (next) {
      lines.push(`下一級需求：${formatCost(next.cost)}`);
      if (next.buffs) lines.push(`-# 升級後效果：${formatBuffList(next.buffs)}`);
      if (next.capacity_bonus)
        lines.push(`-# 升級後再 +${next.capacity_bonus} 容量`);
      const lacks = [];
      for (const [k, v] of Object.entries(next.cost || {})) {
        const have = k === "coins" ? club.treasury_current || 0 : wh[k] || 0;
        if (have < v)
          lacks.push(`${k === "coins" ? "公會資金" : itemLabel(k)} 缺 ${v - have}`);
      }
      if (lacks.length > 0) lines.push(`-# 缺：${lacks.join("・")}`);
      if (isManager && lacks.length === 0) {
        upgradeRows.push({
          kind,
          buttonLabel: `升級${def.label} → Lv.${next.level}`,
          emoji: def.emoji,
        });
      }
    } else {
      lines.push(`-# 🏆 已達最高等級`);
    }
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  }

  // 農膳坊滿級 → 顯示宴會狀態 + 召集按鈕（manager only）
  const farmKitchenLv = bl.farm_kitchen || 0;
  if (
    guildBanquet?.enabled &&
    farmKitchenLv >= banquetService.requiredFarmKitchenLevel()
  ) {
    c.addSeparatorComponents(new SeparatorBuilder());
    const active = banquetService.getActiveBanquet(club);
    const lastAt = club.last_banquet_at
      ? new Date(club.last_banquet_at).getTime()
      : 0;
    const readyAt = lastAt > 0 ? lastAt + banquetService.cooldownMs() : 0;
    const onCooldown = !active && readyAt > 0 && Date.now() < readyAt;

    if (active) {
      const menu = banquetService.menuDef(active.menu_id);
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🍽️ **宴會進行中：${menu?.emoji || ""} ${menu?.name || active.menu_id}**\n` +
            `效果：${formatBuffList(active.buffs)}\n` +
            `席至 <t:${Math.floor(active.expires_at / 1000)}:R>`
        )
      );
    } else if (onCooldown) {
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🍽️ **公會宴會**\n冷卻中，可於 <t:${Math.floor(readyAt / 1000)}:R> 再次召集`
        )
      );
    } else if (isManager) {
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🍽️ **公會宴會**\n農膳坊滿級可召集宴會，給全公會時效 buff。`
        )
      );
      c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gcx_banquet_open|${viewerId}|${club.guild_club_id}`)
            .setLabel("召集宴會")
            .setEmoji("🍽️")
            .setStyle(ButtonStyle.Primary)
        )
      );
    } else {
      c.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🍽️ **公會宴會**\n-# 由會長 / 副會長召集。`
        )
      );
    }
  }

  if (isManager && upgradeRows.length > 0) {
    // 用 Select 收斂可升級項目，避免按鈕爆量
    const sel = new StringSelectMenuBuilder()
      .setCustomId(`gcx_bld_pick|${viewerId}|${club.guild_club_id}`)
      .setPlaceholder("選擇要升級的建築");
    for (const u of upgradeRows.slice(0, 25)) {
      sel.addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(u.buttonLabel)
          .setValue(u.kind)
          .setEmoji(u.emoji)
      );
    }
    c.addSeparatorComponents(new SeparatorBuilder());
    c.addActionRowComponents(new ActionRowBuilder().addComponents(sel));
  } else if (!isManager) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 公會建築升級須由會長 / 副會長操作。`)
    );
  }

  return c;
}

function buildBuildingConfirmPanel({ viewerId, club, kind, next, cost }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  const def = buildingService.kindDef(kind);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${def.emoji} 升級「${def.label}」至 Lv.${next}\n消耗：${formatCost(cost)}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_bld_confirm|${viewerId}|${club.guild_club_id}|${kind}`)
        .setLabel(`確認升級`)
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`gcx_bld_cancel|${viewerId}`)
        .setLabel(`取消`)
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return c;
}

// ───────────────────── 公會宴會 ─────────────────────
function buildBanquetMenuPanel({ viewerId, club, warehouseRows }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_GOLD);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🍽️ ${club.name} 召集公會宴會\n` +
        `選一道菜，材料由公會倉庫扣除，效果套用全公會`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());

  const wh = {};
  for (const r of warehouseRows || []) wh[r.item_id] = r.available_qty || 0;

  const menus = guildBanquet?.menus || {};
  for (const [menuId, menu] of Object.entries(menus)) {
    const matList = [];
    const lackList = [];
    for (const [itemId, need] of Object.entries(menu.materials || {})) {
      const have = wh[itemId] || 0;
      const label = banquetService.itemLabel(itemId);
      const emoji = banquetService.itemEmoji(itemId);
      matList.push(`${emoji} ${label} ×${need}`);
      if (have < need) lackList.push(`${label} 缺 ${need - have}`);
    }
    const durMin = Math.floor((menu.durationMs || 0) / 60000);
    const lines = [
      `${menu.emoji} **${menu.name}**（${durMin} 分鐘）`,
      `-# ${menu.description || ""}`,
      `材料：${matList.join("・")}`,
      `效果：${formatBuffList(menu.buffs)}`,
    ];
    if (lackList.length > 0) lines.push(`-# 缺：${lackList.join("・")}`);
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")));
  }

  const sel = new StringSelectMenuBuilder()
    .setCustomId(`gcx_banquet_pick|${viewerId}|${club.guild_club_id}`)
    .setPlaceholder("選一道菜");
  for (const [menuId, menu] of Object.entries(menus)) {
    sel.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(menu.name)
        .setValue(menuId)
        .setEmoji(menu.emoji || "🍽️")
    );
  }
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(new ActionRowBuilder().addComponents(sel));
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_bld_back|${club.guild_club_id}`)
        .setLabel("返回建築")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return c;
}

function buildBanquetConfirmPanel({ viewerId, club, menuId, menu, warehouseRows }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  const matList = [];
  for (const [itemId, need] of Object.entries(menu.materials || {})) {
    matList.push(`${banquetService.itemEmoji(itemId)} ${banquetService.itemLabel(itemId)} ×${need}`);
  }
  const durMin = Math.floor((menu.durationMs || 0) / 60000);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🍽️ 確認召集「${menu.emoji} ${menu.name}」\n` +
        `公會宴會將消耗：${matList.join("・")}\n` +
        `效果：${formatBuffList(menu.buffs)}（${durMin} 分鐘，全公會生效）`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_banquet_confirm|${viewerId}|${club.guild_club_id}|${menuId}`)
        .setLabel("確認召集")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`gcx_banquet_open|${viewerId}|${club.guild_club_id}`)
        .setLabel("換一道")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`gcx_bld_back|${club.guild_club_id}`)
        .setLabel("取消")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return c;
}

function buildBanquetSuccessPanel({ club, menu, banquet }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_SUCCESS);
  const durMin = Math.floor((menu.durationMs || 0) / 60000);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🍽️ 宴會開席！${menu.emoji} ${menu.name}\n` +
        `${menu.description || ""}\n` +
        `效果：${formatBuffList(banquet.buffs)}（${durMin} 分鐘）\n` +
        `席至 <t:${Math.floor(banquet.expires_at / 1000)}:R>`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_bld_back|${club.guild_club_id}`)
        .setLabel("回建築面板")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return c;
}

// ───────────────────── 通用錯誤 / 成功 ─────────────────────
function buildSimpleError({ title, body, hint }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERROR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint)
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
}

function buildForgeSuccess({ club, recipe, qty, outputQty, inputsUsed, discountPct }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_SUCCESS);
  const inputText = Object.entries(inputsUsed)
    .map(([k, v]) => `${itemEmoji(k)} ${itemLabel(k)} ×${v}`)
    .join("・");
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ✅ 熔爐製造成功\n` +
        `產出：${itemEmoji(recipe.label === "建材" ? "building_material" : "steel_ingot")} ${recipe.label} ×${outputQty}\n` +
        `消耗：${inputText}${discountPct > 0 ? `（精煉站 -${discountPct}%）` : ""}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_forge_back|${club.guild_club_id}`)
        .setLabel(`回熔爐`)
        .setEmoji("🔥")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`gcx_bld_back|${club.guild_club_id}`)
        .setLabel(`查看建築`)
        .setEmoji("🏗️")
        .setStyle(ButtonStyle.Secondary)
    )
  );
  return c;
}

function buildBuildingUpgradeSuccess({ club, kind, fromLevel, toLevel }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_SUCCESS);
  const def = buildingService.kindDef(kind);
  const row = buildingService.levelRow(kind, toLevel);
  let effect = "";
  if (row?.buffs) effect = `\n新效果：${formatBuffList(row.buffs)}`;
  if (row?.capacity_bonus)
    effect = `\n新效果：每物品倉庫容量 +${row.capacity_bonus}（本級）`;
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ✅ ${def.label} 升級成功\nLv.${fromLevel} → Lv.${toLevel}${effect}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_bld_back|${club.guild_club_id}`)
        .setLabel(`回建築面板`)
        .setEmoji("🏗️")
        .setStyle(ButtonStyle.Primary)
    )
  );
  return c;
}

function buildForgeUpgradeSuccess({ club, target, fromLevel, toLevel }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_SUCCESS);
  const label = target === "refinery" ? "精煉站" : "熔爐";
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ✅ ${label} ${fromLevel === 0 ? "建造" : "升級"}成功\nLv.${fromLevel} → Lv.${toLevel}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gcx_forge_back|${club.guild_club_id}`)
        .setLabel(`回熔爐`)
        .setEmoji("🔥")
        .setStyle(ButtonStyle.Primary)
    )
  );
  return c;
}

module.exports = {
  buildForgePanel,
  buildForgeQtyPanel,
  buildBuildingsPanel,
  buildBuildingConfirmPanel,
  buildBanquetMenuPanel,
  buildBanquetConfirmPanel,
  buildBanquetSuccessPanel,
  buildSimpleError,
  buildForgeSuccess,
  buildBuildingUpgradeSuccess,
  buildForgeUpgradeSuccess,
};
