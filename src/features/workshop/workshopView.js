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
  applyRepairDiscount,
} = require("../mining/mineService");
const buildingService = require("../guild_club/buildingService");
const { effectiveWeaponMaxDurability } = buildingService;
const {
  REPAIR_MATERIAL_PREFIX,
  REPAIR_WEAPON_PREFIX,
  REPAIR_ROD_PREFIX,
} = require("../shop/backpackView");

const TAB_PREFIX = "wsTab_";
const CRAFT_SUB_PREFIX = "wsCraftSub_";
const CRAFT_PREFIX = "wsCraft_";
const CRAFT_ALL_PREFIX = "wsCraftAll_";
const CONFIRM_PREFIX = "wsConfirm_";
const CANCEL_PREFIX = "wsCancel_";
const REPAIR_TOOL_PREFIX = "wsRepairTool_";

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
];
const CRAFT_SUB_IDS = CRAFT_SUBS.map((s) => s.id);

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}
function weaponLabel(key) {
  const def = (dungeon?.weapons || {})[key] || {};
  return `${def.emoji || "👊"} ${def.name || key}`;
}
function rodLabel(key) {
  const def = (fishing?.rods || {})[key] || {};
  return `${def.emoji || "🎣"} ${def.name || key}`;
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
function buildEquipmentTab(container, { userId, displayName, profile, weaponMaxPct = 0 }) {
  container
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🛡️ 目前裝備`),
    );

  const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
  const pickDurability =
    profile.pickaxe === "wood" || profile.pickaxe_durability == null
      ? "永久"
      : `${profile.pickaxe_durability}/${profile.pickaxe_max_durability ?? "?"} 次`;
  const luckPct = Math.round((pdef.luckBonus || 0) * 100);
  const cdReduceMin = Math.round((pdef.cdReductionMs || 0) / 60000);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `⛏️ **鎬子**：${pickaxeLabel(profile.pickaxe)}（耐久 ${pickDurability}）\n` +
        `-# luck +${luckPct}% ・ CD -${cdReduceMin} 分 ・ 數量 +${pdef.qtyBonus || 0}`,
    ),
  );

  const wKey = profile.weapon || "fist";
  const wdef = (dungeon?.weapons || {})[wKey] || {};
  const weaponEffMax = effectiveWeaponMaxDurability(profile.weapon_max_durability, weaponMaxPct);
  const weaponDurability =
    wKey === "fist" || profile.weapon_durability == null
      ? "永久"
      : `${profile.weapon_durability}/${weaponEffMax ?? "?"} 次`;
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
        : `${profile.shield_durability}/${profile.shield_max_durability ?? "?"} 次`;
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
      : `${profile.rod_durability}/${profile.rod_max_durability ?? "?"} 次`;
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
      propLine = `效果：+${Math.round((tdef.duraPct || 0) * 100)}% 鎬子耐久 ・ ${deltaTxt}`;
    } else if (type === "fishing_net") {
      const fcfg = craft?.fishingNet || {};
      propLine = `效果：+${Math.round((fcfg.successBonus || 0) * 100)}% 釣魚成功率 ・ ${fcfg.usesPerCraft || 3} 次釣魚成功後失效`;
    } else if (type === "stone_appraisal_trigger") {
      const q = recipe.result?.quality;
      propLine = q === "high"
        ? "效果：觸發優質賭石（diamond 5%、gold 11%，期望 EV ≈ 82 幣 / 顆）"
        : "效果：觸發劣質賭石（與普通賭石同表，期望 EV ≈ 50 幣 / 顆）";
    } else if (type === "advanced_trap") {
      const acfg = craft?.advancedTrap || {};
      propLine = `效果：+${acfg.blocksPerCraft || 4} 次被動抵擋（上限 ${acfg.maxStack || 12}）`;
    } else if (type === "treasure_map") {
      propLine = `效果：合成 1 張藏寶圖，到 /背包 「探險道具」按「使用 1 張」撕開觸發隨機事件`;
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
        `CD -${Math.round((pdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
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
      const trapCfg = craft?.advancedTrap || {};
      const usesNow = profile.advanced_trap_uses || 0;
      const cap = trapCfg.maxStack ?? 12;
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🪤 農場防護（持有破損陷阱碎片 **${fragCount}**，目前保護 ${usesNow} / ${cap} 次）\n-# 合成即自動生效，被動抵擋下一次農場怪物入侵；達上限多餘的次數會被丟掉\n-# 鐵礦打造穩定可控；碎片回收留給農場防禦打下來的舊碎片`,
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
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 礦石來自 /挖礦，魚來自 /釣魚，✨ 傳說素材碎片來自 /地下城 / BOSS",
    ),
  );
}

// ─── 修復分頁 ────────────────────────────────────────────────────────────────
function buildRepairTab(container, { userId, displayName, profile, repairDiscountPct = 0, weaponMaxPct = 0 }) {
  container
    .setAccentColor(0x16a085)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🔧 修復`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 用礦石（鎬子 / 釣竿）或魚（武器）補滿耐久；點下方按鈕直接修`,
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
      profile.pickaxe_durability < profile.pickaxe_max_durability;
    const dura =
      profile.pickaxe === "wood" || profile.pickaxe_durability == null
        ? "永久"
        : `${profile.pickaxe_durability}/${profile.pickaxe_max_durability ?? "?"} 次`;
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
    const weaponEffMax = effectiveWeaponMaxDurability(profile.weapon_max_durability, weaponMaxPct);
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

  // Phase H+ 盾牌（沒有材料修復配方，只能用劣質磨石；提示玩家到 /背包 點修盾）
  {
    const sKey = profile.shield;
    if (sKey) {
      const sdef = (dungeon?.shields || {})[sKey] || {};
      const dura =
        profile.shield_durability == null
          ? "—"
          : `${profile.shield_durability}/${profile.shield_max_durability ?? "?"} 次`;
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🛡️ **盾**：${sdef.emoji || "🛡️"} ${sdef.name || sKey}（耐久 ${dura}）\n` +
            `-# 盾無材料修復配方，到 /背包 用劣質磨石修盾（補滿耐久，盾最大耐久 -10）`,
        ),
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `🛡️ **盾**：—\n-# 還沒裝盾。先到「合成 → 武器/盾」打一面盾再回來修。`,
        ),
      );
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
      profile.rod_durability < profile.rod_max_durability;
    const dura =
      rKey === "bamboo" || profile.rod_durability == null
        ? "永久"
        : `${profile.rod_durability}/${profile.rod_max_durability ?? "?"} 次`;
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
  if (ownedTiers.length > 0 && profile.pickaxe && profile.pickaxe !== "wood") {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `### 🛠️ 維修工具（消耗品，僅對鎬子）\n-# 每使用一張會依階級調整鎬子最大耐久；無背包扣費`,
        ),
      );
    for (const [tier, def] of ownedTiers) {
      const owned = tools[tier];
      const deltaTxt = def.maxDelta === 0
        ? "max 不變"
        : def.maxDelta > 0
          ? `max +${def.maxDelta}`
          : `max ${def.maxDelta}`;
      const body =
        `${def.emoji || "🔧"} **${def.name}** ×${owned}\n` +
        `-# +${Math.round((def.duraPct || 0) * 100)}% 耐久 ・ ${deltaTxt}`;
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
          .setButtonAccessory(
            new ButtonBuilder()
              .setCustomId(`${REPAIR_TOOL_PREFIX}${userId}_${tier}`)
              .setLabel("使用 1 張")
              .setEmoji("🛠️")
              .setStyle(ButtonStyle.Primary),
          ),
      );
    }
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 還沒有維修工具？切到「合成」分頁打造，鐵製便宜、傳說 max +2",
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
  const weaponMaxPct = guildBuffs.weapon_max_durability_pct || 0;

  const container = new ContainerBuilder();
  container.addActionRowComponents(tabRow(userId, tab));
  container.addSeparatorComponents(new SeparatorBuilder());

  if (tab === "equipment") buildEquipmentTab(container, { userId, displayName, profile, weaponMaxPct });
  else if (tab === "craft") buildCraftTab(container, { userId, displayName, profile, craftSub });
  else if (tab === "repair") buildRepairTab(container, { userId, displayName, profile, repairDiscountPct, weaponMaxPct });

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
  TABS,
  CRAFT_SUBS,
  CRAFT_SUB_IDS,
};
