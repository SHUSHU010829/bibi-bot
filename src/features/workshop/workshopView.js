// 工坊統一介面：/裝備 與 /合成 共用，分頁切換 裝備 / 合成 / 修復。
//
// customId 規約：
//   wsTab_<userId>_<tab>            — 切換分頁（tab: equipment / craft / repair）
//   wsCraftSub_<userId>            — 合成分頁的子分類 Select（值為 pickaxe / repair / weapon / shield / fish / misc / farm）
//   wsCraft_<userId>_<recipeId>     — 在合成分頁點某配方的「合成」按鈕
//   wsConfirm_<userId>_<recipeId>   — confirm_needed 時的「確認替換」
//   wsCancel_<userId>               — confirm_needed 時的「取消」
// 修復按鈕沿用既有 mining_repair_material_ / mining_repair_weapon_ / mining_repair_rod_

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require("discord.js");

const { mining, craft, dungeon, fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { ownedMaterial, materialLabel } = require("../mining/craftMaterials");
const { maxCraftTimes } = require("../mining/craftService");
const { playerAtk } = require("../mining/dungeonService");
const {
  getPickaxeRepairCost,
  getWeaponRepairCost,
  getRodRepairCost,
  getShieldRepairCost,
  applyRepairDiscount,
  REPAIR_TOOL_TARGETS,
  repairToolTargetEquipped,
} = require("../mining/mineService");
const buildingService = require("../guild_club/buildingService");
const trapTiers = require("../farm/trapTiers");
const { effectiveMaxOf, bonusSuffix } = require("../mining/equipDurability");
const {
  REPAIR_MATERIAL_PREFIX,
  REPAIR_WEAPON_PREFIX,
  REPAIR_ROD_PREFIX,
  REPAIR_SHIELD_PREFIX,
} = require("../shop/backpackView");

const TAB_PREFIX = "wsTab_";
const CRAFT_SUB_PREFIX = "wsCraftSub_";
const CRAFT_PREFIX = "wsCraft_";
const CRAFT_ALL_PREFIX = "wsCraftAll_";
const CONFIRM_PREFIX = "wsConfirm_";
const CANCEL_PREFIX = "wsCancel_";
const REPAIR_TOOL_PREFIX = "wsRepairTool_";
const REPAIR_TOOL_APPLY_PREFIX = "wsRepairToolApply_";

const TABS = ["equipment", "craft", "repair"];

const CRAFT_SUBS = [
  { id: "pickaxe", label: "鎬子", emoji: "⛏️", types: ["pickaxe"] },
  { id: "repair", label: "維修", emoji: "🛠️", types: ["repair_tool"] },
  // 武器與盾牌各自獨立分頁：合計 10 個配方併在一頁會頂破元件上限 40
  { id: "weapon", label: "武器", emoji: "⚔️", types: ["weapon"] },
  { id: "shield", label: "盾牌", emoji: "🛡️", types: ["shield"] },
  { id: "fish", label: "釣魚", emoji: "🎣", types: ["rod", "fishing_net"] },
  { id: "misc", label: "賭石/藏寶", emoji: "🪨", types: ["stone_appraisal_trigger", "treasure_map"] },
  { id: "farm", label: "農場", emoji: "🪤", types: ["advanced_trap", "ore"] },
  { id: "event", label: "活動", emoji: "🛤️", types: ["pioneer_hammer", "sealing_ammo"] },
];
const CRAFT_SUB_IDS = CRAFT_SUBS.map((s) => s.id);

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}
// 鎬子的 CD 減免有固定分鐘與比例兩段（比例是在固定扣完後才乘），兩段都要寫給玩家看
function pickaxeCdText(def) {
  const min = Math.round((def.cdReductionMs || 0) / 60000);
  const pct = def.cdReductionPct || 0;
  return pct > 0 ? `CD -${min} 分後再 -${pct}%` : `CD -${min} 分`;
}
function weaponLabel(key) {
  const def = (dungeon?.weapons || {})[key] || {};
  return `${def.emoji || "👊"} ${def.name || key}`;
}
function rodLabel(key) {
  const def = (fishing?.rods || {})[key] || {};
  return `${def.emoji || "🎣"} ${def.name || key}`;
}

function toolEffectText(def) {
  const deltaTxt = def.maxDelta === 0
    ? "上限不變"
    : def.maxDelta > 0
      ? `上限 +${def.maxDelta}`
      : `上限 ${def.maxDelta}`;
  return `修復 ${Math.round((def.duraPct || 0) * 100)}% 耐久 ・ ${deltaTxt}`;
}

// 維修工具用 Select 而非每階一個 Section+按鈕：6 階原本要 20 個元件，
// 修復分頁實測已到 37/40，再加一階就爆掉。Select 固定 2 個元件、可放 25 個選項。
function repairToolSelect(userId, ownedTiers, tools) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${REPAIR_TOOL_PREFIX}${userId}`)
      .setPlaceholder("選一張維修工具使用")
      .addOptions(
        ownedTiers.map(([tier, def]) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(`${def.name} ×${tools[tier] || 0}`)
            .setValue(tier)
            .setDescription(toolEffectText(def))
            .setEmoji(def.emoji || "🔧"),
        ),
      ),
  );
}

function shieldLabel(key) {
  const d = (dungeon?.shields || {})[key] || {};
  return `${d.emoji || "🛡️"} ${d.name || key}`;
}

const equippedLabel = (profile, target) => {
  if (target === "pickaxe") return pickaxeLabel(profile.pickaxe);
  if (target === "weapon") return weaponLabel(profile.weapon);
  if (target === "shield") return shieldLabel(profile.shield);
  return rodLabel(profile.fishing_rod);
};

// 維修工具第二段：選完工具後跳這張面板挑要修哪件裝備。
// 不做成「工具 × 裝備」的 24 個 Select 選項，避免選單變成一面牆。
function buildRepairToolTargetPanel({ userId, tier, def, profile }) {
  const c = new ContainerBuilder()
    .setAccentColor(0x16a085)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${def.emoji || "🔧"} ${def.name}\n${toolEffectText(def)}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  const rows = [];
  const row = new ActionRowBuilder();
  for (const [target, spec] of Object.entries(REPAIR_TOOL_TARGETS)) {
    const equipped = repairToolTargetEquipped(profile, target);
    const curMax = profile[spec.maxField];
    const blocked = equipped && (def.maxDelta || 0) < 0 && curMax + def.maxDelta < 10;
    rows.push(
      equipped
        ? `${spec.emoji} **${spec.label}**：${equippedLabel(profile, target)}（耐久 ${profile[spec.duraField] ?? "—"}/${curMax}）`
          + (blocked ? `　-# 上限會降到 ${curMax + def.maxDelta}，低於 10 不可用` : "")
        : `${spec.emoji} **${spec.label}**：未裝備`,
    );
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${REPAIR_TOOL_APPLY_PREFIX}${userId}_${tier}_${target}`)
        .setLabel(spec.label)
        .setEmoji(spec.emoji)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!equipped || blocked),
    );
  }
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(rows.join("\n")));
  c.addActionRowComponents(row);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 選一件裝備使用這張工具；用掉後不可撤回"),
  );
  return c;
}

// 分類用 Select 而非一排按鈕：按鈕版每個分頁要 1 顆（分頁數 >5 還得多一個 ActionRow），
// 在元件上限 40 之下會擠掉配方；Select 固定只花 2 個元件。
function craftSubSelect(userId, currentSub) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CRAFT_SUB_PREFIX}${userId}`)
      .setPlaceholder("選擇合成分類")
      .addOptions(
        CRAFT_SUBS.map((sub) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(sub.label)
            .setValue(sub.id)
            .setEmoji(sub.emoji)
            .setDefault(currentSub === sub.id),
        ),
      ),
  );
}

function tabRow(userId, current) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TAB_PREFIX}${userId}_equipment`)
      .setLabel("裝備")
      .setEmoji("🛡️")
      .setStyle(current === "equipment" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "equipment"),
    new ButtonBuilder()
      .setCustomId(`${TAB_PREFIX}${userId}_craft`)
      .setLabel("合成")
      .setEmoji("🔨")
      .setStyle(current === "craft" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "craft"),
    new ButtonBuilder()
      .setCustomId(`${TAB_PREFIX}${userId}_repair`)
      .setLabel("修復")
      .setEmoji("🔧")
      .setStyle(current === "repair" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(current === "repair"),
  );
}

function formatCostInline(profile, cost) {
  if (!cost) return "";
  return Object.entries(cost)
    .map(([mat, qty]) => {
      const have = ownedMaterial(profile, mat);
      const mark = have >= qty ? "✅" : "❌";
      return `${materialLabel(mat)}×${qty}（有 ${have}）${mark}`;
    })
    .join("、");
}

// ─── 裝備分頁 ────────────────────────────────────────────────────────────────
function buildEquipmentTab(container, { userId, displayName, profile, equipMaxPct = 0 }) {
  const effMaxOf = (slot) => effectiveMaxOf(profile, slot, equipMaxPct);
  container
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🛡️ 目前裝備`),
    );

  const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
  const pickDurability =
    profile.pickaxe === "wood" || profile.pickaxe_durability == null
      ? "永久"
      : `${profile.pickaxe_durability}/${effMaxOf("pickaxe") ?? "?"} 次${bonusSuffix(profile, "pickaxe")}`;
  const luckPct = Math.round((pdef.luckBonus || 0) * 100);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `⛏️ **鎬子**：${pickaxeLabel(profile.pickaxe)}（耐久 ${pickDurability}）\n` +
        `-# luck +${luckPct}% ・ ${pickaxeCdText(pdef)} ・ 數量 +${pdef.qtyBonus || 0}`,
    ),
  );

  const wKey = profile.weapon || "fist";
  const wdef = (dungeon?.weapons || {})[wKey] || {};
  const weaponEffMax = effMaxOf("weapon");
  const weaponDurability =
    wKey === "fist" || profile.weapon_durability == null
      ? "永久"
      : `${profile.weapon_durability}/${weaponEffMax ?? "?"} 次${bonusSuffix(profile, "weapon")}`;
  const critPct = Math.round((wdef.critRate || 0) * 100);
  const atk = playerAtk(profile);
  const weaponNote = wKey === "fist" ? "（赤手戰勝率極低，先合成一把劍！）" : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `⚔️ **武器**：${weaponLabel(wKey)}（耐久 ${weaponDurability}）${weaponNote}\n` +
        `-# 戰鬥力 **${atk}**` +
        (wdef.def ? ` ・ 🛡️ DEF ${wdef.def}` : "") +
        (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : ""),
    ),
  );

  // Phase H+ 盾牌
  const sKey = profile.shield;
  if (sKey) {
    const sdef = (dungeon?.shields || {})[sKey] || {};
    const shieldDurability =
      profile.shield_durability == null
        ? "—"
        : `${profile.shield_durability}/${effMaxOf("shield") ?? "?"} 次${bonusSuffix(profile, "shield")}`;
    const blockPct = Math.round((sdef.blockRate || 0) * 100);
    const refPct = Math.round((sdef.reflectRate || 0) * 100);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🛡️ **盾**：${sdef.emoji || "🛡️"} ${sdef.name || sKey}（耐久 ${shieldDurability}）\n` +
          `-# DEF +${sdef.def || 0} ・ 格擋 ${blockPct}%` +
          (refPct > 0 ? ` ・ 反射 ${refPct}%` : ""),
      ),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🛡️ **盾**：—\n-# 還沒裝盾。Lv.5 起可到「合成 → 武器/盾」打一面 🪨 鐵盾（DEF +10、格擋 25%）`,
      ),
    );
  }

  const rodKey = profile.fishing_rod || "bamboo";
  const rdef = (fishing?.rods || {})[rodKey] || {};
  const rodDurability =
    rodKey === "bamboo" || profile.rod_durability == null
      ? "永久"
      : `${profile.rod_durability}/${effMaxOf("rod") ?? "?"} 次${bonusSuffix(profile, "rod")}`;
  const rodSuccessPct = Math.round((rdef.successBonus || 0) * 100);
  const rodCdReduceMin = Math.round((rdef.cdReductionMs || 0) / 60000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `🪝 **釣竿**：${rodLabel(rodKey)}（耐久 ${rodDurability}）\n` +
        `-# 成功率 +${rodSuccessPct}% ・ 稀有度 +${rdef.rareBonus || 0} ・ CD -${rodCdReduceMin} 分 ・ 數量 +${rdef.qtyBonus || 0} ・ 豐收 ${Math.round((rdef.bonusChance || 0) * 100)}%`,
    ),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`✨ 傳說素材碎片：**${profile.legendary_fragments || 0}**`),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 切到「合成」打造新裝備、「修復」補耐久；裝備耐久 0 會自動退回基礎裝備",
    ),
  );
}

// ─── 合成分頁 ────────────────────────────────────────────────────────────────
// 組一個配方的說明文字（材料盤點 + 屬性／效果），合成與合成全部共用。
function recipeBodyText(recipe, profile, type) {
    const matParts = Object.entries(recipe.materials).map(([mat, need]) => {
      const have = ownedMaterial(profile, mat);
      const ok = have >= need;
      return `${ok ? "✅" : "❌"} ${materialLabel(mat)} ${have}/${need}`;
    });
    const craftable = Object.entries(recipe.materials).every(
      ([mat, need]) => ownedMaterial(profile, mat) >= need,
    );
    const resultId = recipe.result?.id;
    let propLine = "";
    if (type === "repair_tool") {
      const tdef = (craft?.repairTools || {})[resultId] || {};
      const deltaTxt = tdef.maxDelta === 0
        ? "max 不變"
        : tdef.maxDelta > 0
          ? `max +${tdef.maxDelta}`
          : `max ${tdef.maxDelta}`;
      propLine = `效果：+${Math.round((tdef.duraPct || 0) * 100)}% 耐久 ・ ${deltaTxt} ・ 鎬/劍/盾/釣竿通用`;
    } else if (type === "fishing_net") {
      const fcfg = craft?.fishingNet || {};
      propLine = `效果：+${Math.round((fcfg.successBonus || 0) * 100)}% 釣魚成功率 ・ ${fcfg.usesPerCraft || 3} 次釣魚成功後失效`;
    } else if (type === "stone_appraisal_trigger") {
      const q = recipe.result?.quality;
      propLine = q === "high"
        ? "效果：觸發優質賭石（diamond 5%、gold 11%，期望 EV ≈ 82 幣 / 顆）"
        : "效果：觸發劣質賭石（與普通賭石同表，期望 EV ≈ 50 幣 / 顆）";
    } else if (type === "advanced_trap") {
      const t = trapTiers.trapTier(recipe.result?.tier);
      const pct = Math.round((t.blockChance ?? 1) * 100);
      const rate = pct >= 100 ? "**必定抵擋**" : `**${pct}% 抵擋**（會失效）`;
      propLine =
        `效果：+${t.blocksPerCraft || 4} 次被動抵擋，${rate}`
        + `・期望擋下 ${((t.blocksPerCraft || 4) * (t.blockChance ?? 1)).toFixed(1)} 次（共用上限 ${trapTiers.maxStack()}）`;
    } else if (type === "treasure_map") {
      propLine = `效果：合成 1 張藏寶圖，到 /背包 「探險道具」按「使用 1 張」撕開觸發隨機事件`;
    } else if (type === "sealing_ammo") {
      const acfg = require("../../config").boss?.sealingAmmo || {};
      propLine = `效果：魔王戰攻擊次數 +${acfg.attackLimitBonus || 0}・世界王傷害 +${acfg.bossDamagePct || 0}%（另需 ${(acfg.coinCost || 0).toLocaleString()} 逼幣）`;
    } else if (type === "pioneer_hammer") {
      propLine = `效果：解鎖全服共建活動的投入資格（非消耗品，持有一把即可）`;
    } else if (type === "ore") {
      const odef = mining?.ores?.[recipe.result?.id] || {};
      const oqty = recipe.result?.qty ?? 1;
      propLine = `效果：產出 ${odef.emoji || ""} ${odef.name || recipe.result?.id} ×${oqty}（佔背包格）`;
    } else if (type === "weapon") {
      const wdef = (dungeon?.weapons || {})[resultId] || {};
      const totalAtk = (dungeon?.baseAtk ?? 20) + (wdef.atk || 0);
      const critPct = Math.round((wdef.critRate || 0) * 100);
      const defAttr = wdef.def ? ` ・ 🛡️ DEF ${wdef.def}` : "";
      propLine =
        `屬性：⚔️ 戰鬥力 ${totalAtk}${defAttr}` +
        (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : "") +
        ` ・ 耐久 ${wdef.durability ?? "永久"}`;
    } else if (type === "shield") {
      const sdef = (dungeon?.shields || {})[resultId] || {};
      const blockPct = Math.round((sdef.blockRate || 0) * 100);
      const refPct = Math.round((sdef.reflectRate || 0) * 100);
      propLine =
        `屬性：🛡️ DEF +${sdef.def || 0} ・ 格擋 ${blockPct}%` +
        (refPct > 0 ? ` ・ 反射 ${refPct}%` : "") +
        ` ・ 耐久 ${sdef.durability ?? "永久"}`;
    } else if (type === "rod") {
      const rdef = (fishing?.rods || {})[resultId] || {};
      propLine =
        `屬性：成功率 +${Math.round((rdef.successBonus || 0) * 100)}% ・ ` +
        `稀有度 +${rdef.rareBonus || 0} ・ CD -${Math.round((rdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
        `數量 +${rdef.qtyBonus || 0} ・ 豐收 ${Math.round((rdef.bonusChance || 0) * 100)}% ・ 耐久 ${rdef.durability ?? "永久"}`;
    } else {
      const pdef = (mining?.pickaxes || {})[resultId] || {};
      propLine =
        `屬性：luck +${Math.round((pdef.luckBonus || 0) * 100)}% ・ ` +
        `${pickaxeCdText(pdef)} ・ ` +
        `數量 +${pdef.qtyBonus || 0} ・ 耐久 ${pdef.durability ?? "永久"}`;
    }

    const body =
      `**${recipe.name}${craftable ? "（可合成）" : ""}**\n` +
      matParts.join("\n") +
      `\n-# ${propLine}`;
    return { body, craftable };
}

function craftableSection(container, recipes, profile, type, userId) {
  for (const recipe of recipes) {
    const { body, craftable } = recipeBodyText(recipe, profile, type);
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`${CRAFT_PREFIX}${userId}_${recipe.id}`)
            .setLabel("合成")
            .setEmoji("🔨")
            .setStyle(craftable ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!craftable),
        ),
    );
  }
}

// 賭石碎石回收專用：每個配方一段文字 + 一排「合成（1 顆）／合成全部（N 顆）」按鈕。
function appraisalCraftSection(container, recipes, profile, userId) {
  const cap = Math.max(1, mining?.stoneAppraisal?.maxBatch || 50);
  for (const recipe of recipes) {
    const { body, craftable } = recipeBodyText(recipe, profile, "stone_appraisal_trigger");
    const maxTimes = Math.min(maxCraftTimes(profile, recipe), cap);
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${CRAFT_PREFIX}${userId}_${recipe.id}`)
            .setLabel("合成 1 顆")
            .setEmoji("🔨")
            .setStyle(craftable ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!craftable),
          new ButtonBuilder()
            .setCustomId(`${CRAFT_ALL_PREFIX}${userId}_${recipe.id}`)
            .setLabel(maxTimes > 1 ? `合成全部（${maxTimes} 顆）` : "合成全部")
            .setEmoji("✨")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(maxTimes <= 1),
        ),
      );
  }
}

function buildCraftTab(container, { userId, displayName, profile, craftSub }) {
  if (!CRAFT_SUB_IDS.includes(craftSub)) craftSub = "pickaxe";

  container
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🔨 合成`),
    )
    .addActionRowComponents(craftSubSelect(userId, craftSub))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 點配方右側「合成」即可打造；舊裝備若仍有耐久會跳出二次確認`,
      ),
    );

  const recipes = craft?.recipes || [];
  const pickaxes = recipes.filter((r) => (r.result?.type || "pickaxe") === "pickaxe");
  const weapons = recipes.filter((r) => r.result?.type === "weapon");
  const shields = recipes.filter((r) => r.result?.type === "shield");
  const rods = recipes.filter((r) => r.result?.type === "rod");
  const repairTools = recipes.filter((r) => r.result?.type === "repair_tool");
  const consumables = recipes.filter((r) => r.result?.type === "fishing_net");
  const appraisalTriggers = recipes.filter((r) => r.result?.type === "stone_appraisal_trigger");
  const farmTools = recipes.filter((r) => r.result?.type === "advanced_trap");
  const treasureMaps = recipes.filter((r) => r.result?.type === "treasure_map");
  const oreRecycles = recipes.filter((r) => r.result?.type === "ore");
  const eventTools = recipes.filter((r) => r.result?.type === "pioneer_hammer");
  const bossAmmo = recipes.filter((r) => r.result?.type === "sealing_ammo");

  if (craftSub === "pickaxe") {
    if (pickaxes.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### ⛏️ 鎬子（採集）"));
      craftableSection(container, pickaxes, profile, "pickaxe", userId);
    }
  } else if (craftSub === "repair") {
    if (repairTools.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "### 🛠️ 維修工具（消耗品）\n-# 合成完到「修復」分頁使用，可堆疊持有",
          ),
        );
      craftableSection(container, repairTools, profile, "repair_tool", userId);
    }
  } else if (craftSub === "weapon") {
    if (weapons.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### ⚔️ 武器（戰鬥）"));
      craftableSection(container, weapons, profile, "weapon", userId);
    }
  } else if (craftSub === "shield") {
    if (shields.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "### 🛡️ 盾牌（地下城戰鬥）\n-# 盾本身不扣耐久，戰鬥觸發格擋 / 反射才磨損；歸零仍可裝備但所有判定失效",
          ),
        );
      craftableSection(container, shields, profile, "shield", userId);
    }
  } else if (craftSub === "fish") {
    if (rods.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### 🎣 釣竿（釣魚）"));
      craftableSection(container, rods, profile, "rod", userId);
    }
    if (consumables.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "### 🕸️ 釣魚消耗品\n-# 合成後 buff 自動生效，於 /釣魚 自動套用",
          ),
        );
      craftableSection(container, consumables, profile, "fishing_net", userId);
    }
  } else if (craftSub === "misc") {
    if (appraisalTriggers.length) {
      const shardCount = (profile.backpack || {}).stone_shard || 0;
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### <:crack_stone:1516055109199597708> 賭石碎石回收（持有碎石 **${shardCount}**）\n-# 「合成全部」把現有碎石一次換成多顆賭石；合成完 10 分鐘內按「立刻賭石」一次開出，過期就失效`,
          ),
        );
      appraisalCraftSection(container, appraisalTriggers, profile, userId);
    }
    if (treasureMaps.length) {
      const fragCount = profile.treasure_map_fragments || 0;
      const mapCount = profile.treasure_maps || 0;
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🗺️ 藏寶圖（持有碎片 **${fragCount}** ・ 完整圖 **${mapCount}**）\n-# 合成完到 /背包「探險道具」按「使用 1 張」撕開，可能找到金幣、體力藥水、寶箱怪、或一張惡作劇紙條`,
          ),
        );
      craftableSection(container, treasureMaps, profile, "treasure_map", userId);
    }
  } else if (craftSub === "farm") {
    const fragCount = profile.broken_trap_fragments || 0;
    if (farmTools.length) {
      const usesNow = trapTiers.totalTrapUses(profile);
      const cap = trapTiers.maxStack();
      const held = trapTiers.describeHoldings(profile);
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🪤 農場防護（持有破損陷阱碎片 **${fragCount}**，目前保護 ${usesNow} / ${cap} 次）\n`
              + (held.length ? `-# 持有：${held.join("・")}\n` : "")
              + `-# 🪤 簡易陷阱（鐵礦 ×20）好取得但 **70% 抵擋**；⚙️ 高級陷阱（碎片 ×5）**必定抵擋**\n`
              + `-# 抵擋時先消耗簡易的，把高級的留到後面；兩階共用 ${cap} 次上限`,
          ),
        );
      craftableSection(container, farmTools, profile, "advanced_trap", userId);
    }
    if (oreRecycles.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🔥 碎片熔煉（持有破損陷阱碎片 **${fragCount}**）\n-# 用不完的碎片可以熔回鐵料。熔煉有損耗，直接打造陷阱還是比較划算`,
          ),
        );
      craftableSection(container, oreRecycles, profile, "ore", userId);
    }
  } else if (craftSub === "event") {
    if (eventTools.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            profile.pioneer_hammer
              ? `### 🛤️ 世界主線活動\n✅ 你已經有 **拓荒錘**，可以到 \`/世界事件\` 對進度條投入資源`
              : `### 🛤️ 世界主線活動\n-# 打造拓荒錘才能參與全服共建。非消耗品，一把用到底`,
          ),
        );
      craftableSection(container, eventTools, profile, "pioneer_hammer", userId);
    }
    if (bossAmmo.length) {
      const acfg = require("../../config").boss?.sealingAmmo || {};
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 💥 封魔彈藥（持有 **${profile.sealing_ammo_count || 0}**）\n`
              + `-# 以魔制魔的消耗品，週六魔王戰用。每週限做 1 個，另需 ${(acfg.coinCost || 0).toLocaleString()} 逼幣\n`
              + `-# 效果：該場魔王戰攻擊次數 +${acfg.attackLimitBonus || 0}、世界王傷害 +${acfg.bossDamagePct || 0}%（單場限用 1 個）`,
          ),
        );
      craftableSection(container, bossAmmo, profile, "sealing_ammo", userId);
    }
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 礦石來自 /挖礦，魚來自 /釣魚，✨ 傳說素材碎片來自 /地下城 / BOSS",
    ),
  );
}

// ─── 修復分頁 ────────────────────────────────────────────────────────────────
function buildRepairTab(container, { userId, displayName, profile, repairDiscountPct = 0, equipMaxPct = 0 }) {
  const effMaxOf = (slot) => effectiveMaxOf(profile, slot, equipMaxPct);
  container
    .setAccentColor(0x16a085)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🔧 修復`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 用礦石／魚補滿耐久，不扣上限（鎬子・武器・盾牌・釣竿）；點右側按鈕直接修`,
      ),
    );

  // 鎬子
  {
    const cost = applyRepairDiscount(getPickaxeRepairCost(profile), repairDiscountPct);
    const can =
      cost !== null &&
      profile.pickaxe !== "wood" &&
      typeof profile.pickaxe_durability === "number" &&
      typeof profile.pickaxe_max_durability === "number" &&
      profile.pickaxe_durability < effMaxOf("pickaxe");
    const dura =
      profile.pickaxe === "wood" || profile.pickaxe_durability == null
        ? "永久"
        : `${profile.pickaxe_durability}/${effMaxOf("pickaxe") ?? "?"} 次`;
    const body = profile.pickaxe === "wood"
      ? `⛏️ **鎬子**：木鎬（不需修復）`
      : cost
        ? `⛏️ **鎬子**：${pickaxeLabel(profile.pickaxe)}（耐久 ${dura}）\n🛠️ 消耗：${formatCostInline(profile, cost)}`
        : `⛏️ **鎬子**：${pickaxeLabel(profile.pickaxe)}（耐久 ${dura}）\n-# 無修復配方`;
    if (cost && profile.pickaxe !== "wood") {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${REPAIR_MATERIAL_PREFIX}${userId}`)
              .setLabel("修復")
              .setEmoji("🛠️")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!can),
          ),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }
  }

  // 武器
  {
    const cost = applyRepairDiscount(getWeaponRepairCost(profile), repairDiscountPct);
    const wKey = profile.weapon || "fist";
    const weaponEffMax = effMaxOf("weapon");
    const can =
      cost !== null &&
      wKey !== "fist" &&
      typeof profile.weapon_durability === "number" &&
      typeof weaponEffMax === "number" &&
      profile.weapon_durability < weaponEffMax;
    const dura =
      wKey === "fist" || profile.weapon_durability == null
        ? "永久"
        : `${profile.weapon_durability}/${weaponEffMax ?? "?"} 次`;
    const body = wKey === "fist"
      ? `⚔️ **武器**：拳頭（不需修復）`
      : cost
        ? `⚔️ **武器**：${weaponLabel(wKey)}（耐久 ${dura}）\n🛠️ 消耗：${formatCostInline(profile, cost)}`
        : `⚔️ **武器**：${weaponLabel(wKey)}（耐久 ${dura}）\n-# 無修復配方`;
    if (cost && wKey !== "fist") {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${REPAIR_WEAPON_PREFIX}${userId}`)
              .setLabel("修復")
              .setEmoji("🛠️")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!can),
          ),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }
  }

  // 盾牌
  {
    const sKey = profile.shield;
    if (!sKey) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🛡️ **盾**：—\n-# 還沒裝盾。先到「合成 → 盾牌」打一面盾再回來修。`,
        ),
      );
    } else {
      const sdef = (dungeon?.shields || {})[sKey] || {};
      const cost = applyRepairDiscount(getShieldRepairCost(profile), repairDiscountPct);
      const can =
        cost !== null &&
        typeof profile.shield_durability === "number" &&
        typeof profile.shield_max_durability === "number" &&
        profile.shield_durability < effMaxOf("shield");
      const dura =
        profile.shield_durability == null
          ? "—"
          : `${profile.shield_durability}/${effMaxOf("shield") ?? "?"} 次`;
      const label = `${sdef.emoji || "🛡️"} ${sdef.name || sKey}`;
      const body = cost
        ? `🛡️ **盾**：${label}（耐久 ${dura}）\n🛠️ 消耗：${formatCostInline(profile, cost)}`
        : `🛡️ **盾**：${label}（耐久 ${dura}）\n-# 無修復配方`;
      if (cost) {
        container.addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .setButtonAccessory(
              new ButtonBuilder()
                .setCustomId(`${REPAIR_SHIELD_PREFIX}${userId}`)
                .setLabel("修復")
                .setEmoji("🛠️")
                .setStyle(ButtonStyle.Primary)
                .setDisabled(!can),
            ),
        );
      } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
      }
    }
  }

  // 釣竿
  {
    const cost = applyRepairDiscount(getRodRepairCost(profile), repairDiscountPct);
    const rKey = profile.fishing_rod || "bamboo";
    const can =
      cost !== null &&
      rKey !== "bamboo" &&
      typeof profile.rod_durability === "number" &&
      typeof profile.rod_max_durability === "number" &&
      profile.rod_durability < effMaxOf("rod");
    const dura =
      rKey === "bamboo" || profile.rod_durability == null
        ? "永久"
        : `${profile.rod_durability}/${effMaxOf("rod") ?? "?"} 次`;
    const body = rKey === "bamboo"
      ? `🪝 **釣竿**：竹竿（不需修復）`
      : cost
        ? `🪝 **釣竿**：${rodLabel(rKey)}（耐久 ${dura}）\n🛠️ 消耗：${formatCostInline(profile, cost)}`
        : `🪝 **釣竿**：${rodLabel(rKey)}（耐久 ${dura}）\n-# 無修復配方`;
    if (cost && rKey !== "bamboo") {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${REPAIR_ROD_PREFIX}${userId}`)
              .setLabel("修復")
              .setEmoji("🛠️")
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!can),
          ),
      );
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }
  }

  // 維修工具（消耗品，僅對鎬子）
  const tools = profile.repair_tools || {};
  const ownedTiers = Object.entries((craft?.repairTools || {}))
    .filter(([tier]) => (tools[tier] || 0) > 0);
  const anyTargetEquipped = Object.keys(REPAIR_TOOL_TARGETS).some((t) =>
    repairToolTargetEquipped(profile, t),
  );
  if (ownedTiers.length > 0 && anyTargetEquipped) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🛠️ 維修工具（消耗品）\n-# 鎬子・武器・盾牌・釣竿都能用，不吃背包材料；每張會依階級調整該裝備的耐久上限\n-# 調整量會累積下來，升級或更換裝備時一併帶走（傳說 +2 疊幾張就留幾點）`,
        ),
      );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        ownedTiers
          .map(([tier, def]) => `${def.emoji || "🔧"} **${def.name}** ×${tools[tier]}　-# ${toolEffectText(def)}`)
          .join("\n"),
      ),
    );
    container.addActionRowComponents(repairToolSelect(userId, ownedTiers, tools));
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 還沒有維修工具？切到「合成」分頁打造，鐵製便宜、傳說 max +2（升級裝備後仍保留）",
    ),
  );
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────
async function buildView(client, { userId, guildId, displayName, tab = "equipment", craftSub = "pickaxe" }) {
  if (!TABS.includes(tab)) tab = "equipment";
  const profile = await getOrCreate(client, userId, guildId);
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const repairDiscountPct = guildBuffs.equipment_repair_discount_pct || 0;
  const equipMaxPct = guildBuffs.equipment_max_durability_pct || 0;

  const container = new ContainerBuilder();
  container.addActionRowComponents(tabRow(userId, tab));
  container.addSeparatorComponents(new SeparatorBuilder());

  if (tab === "equipment") buildEquipmentTab(container, { userId, displayName, profile, equipMaxPct });
  else if (tab === "craft") buildCraftTab(container, { userId, displayName, profile, craftSub });
  else if (tab === "repair") buildRepairTab(container, { userId, displayName, profile, repairDiscountPct, equipMaxPct });

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

module.exports = {
  buildView,
  TAB_PREFIX,
  CRAFT_SUB_PREFIX,
  CRAFT_PREFIX,
  CRAFT_ALL_PREFIX,
  CONFIRM_PREFIX,
  CANCEL_PREFIX,
  REPAIR_TOOL_PREFIX,
  REPAIR_TOOL_APPLY_PREFIX,
  buildRepairToolTargetPanel,
  TABS,
  CRAFT_SUBS,
  CRAFT_SUB_IDS,
};
