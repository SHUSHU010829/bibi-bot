// 工坊統一介面：/裝備 與 /合成 共用，分頁切換 裝備 / 合成 / 修復。
//
// customId 規約：
//   wsTab_<userId>_<tab>            — 切換分頁（tab: equipment / craft / repair）
//   wsCraftSub_<userId>_<sub>       — 在合成分頁切子分類（tools / battle / fish / misc）
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
  MessageFlags,
} = require("discord.js");

const { mining, craft, dungeon, fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { playerAtk } = require("../mining/dungeonService");
const {
  getPickaxeRepairCost,
  getWeaponRepairCost,
  getRodRepairCost,
} = require("../mining/mineService");
const {
  REPAIR_MATERIAL_PREFIX,
  REPAIR_WEAPON_PREFIX,
  REPAIR_ROD_PREFIX,
} = require("../shop/backpackView");

const TAB_PREFIX = "wsTab_";
const CRAFT_SUB_PREFIX = "wsCraftSub_";
const CRAFT_PREFIX = "wsCraft_";
const CONFIRM_PREFIX = "wsConfirm_";
const CANCEL_PREFIX = "wsCancel_";
const REPAIR_TOOL_PREFIX = "wsRepairTool_";

const TABS = ["equipment", "craft", "repair"];

const CRAFT_SUBS = [
  { id: "tools", label: "鎬子・維修", emoji: "⛏️", types: ["pickaxe", "repair_tool"] },
  { id: "battle", label: "武器", emoji: "⚔️", types: ["weapon"] },
  { id: "fish", label: "釣魚", emoji: "🎣", types: ["rod", "fishing_net"] },
  { id: "misc", label: "其他", emoji: "🪨", types: ["stone_appraisal_trigger", "advanced_trap", "treasure_map"] },
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

function isFishMaterial(mat) {
  return !!(fishing?.fish && fishing.fish[mat]);
}

function ownedMaterial(profile, mat) {
  if (mat === "legendary_fragment") return profile.legendary_fragments || 0;
  if (isFishMaterial(mat)) return (profile.fish_bag || {})[mat] || 0;
  return (profile.backpack || {})[mat] || 0;
}

function materialLabel(mat) {
  if (mat === "legendary_fragment") return "✨ 傳說素材碎片";
  if (isFishMaterial(mat)) {
    const f = fishing.fish[mat] || {};
    return `${f.emoji || "🐟"} ${f.name || mat}`;
  }
  const def = mining?.ores?.[mat] || mining?.specialOres?.[mat] || {};
  return `${def.emoji || "⛏️"} ${def.name || mat}`;
}

function craftSubRow(userId, currentSub) {
  const row = new ActionRowBuilder();
  for (const sub of CRAFT_SUBS) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${CRAFT_SUB_PREFIX}${userId}_${sub.id}`)
        .setLabel(sub.label)
        .setEmoji(sub.emoji)
        .setStyle(currentSub === sub.id ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(currentSub === sub.id),
    );
  }
  return row;
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
function buildEquipmentTab(container, { userId, displayName, profile }) {
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
  const weaponDurability =
    wKey === "fist" || profile.weapon_durability == null
      ? "永久"
      : `${profile.weapon_durability}/${profile.weapon_max_durability ?? "?"} 次`;
  const critPct = Math.round((wdef.critRate || 0) * 100);
  const atk = playerAtk(profile);
  const weaponNote = wKey === "fist" ? "（赤手戰勝率極低，先合成一把劍！）" : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `⚔️ **武器**：${weaponLabel(wKey)}（耐久 ${weaponDurability}）${weaponNote}\n` +
        `-# 戰鬥力 **${atk}**` +
        (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : ""),
    ),
  );

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
        `-# 成功率 +${rodSuccessPct}% ・ 稀有度 +${rdef.rareBonus || 0} ・ CD -${rodCdReduceMin} 分 ・ 數量 +${rdef.qtyBonus || 0}`,
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
function craftableSection(container, recipes, profile, type, userId) {
  for (const recipe of recipes) {
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
    } else if (type === "weapon") {
      const wdef = (dungeon?.weapons || {})[resultId] || {};
      const totalAtk = (dungeon?.baseAtk ?? 20) + (wdef.atk || 0);
      const critPct = Math.round((wdef.critRate || 0) * 100);
      propLine =
        `屬性：⚔️ 戰鬥力 ${totalAtk}` +
        (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : "") +
        ` ・ 耐久 ${wdef.durability ?? "永久"}`;
    } else if (type === "rod") {
      const rdef = (fishing?.rods || {})[resultId] || {};
      propLine =
        `屬性：成功率 +${Math.round((rdef.successBonus || 0) * 100)}% ・ ` +
        `稀有度 +${rdef.rareBonus || 0} ・ CD -${Math.round((rdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
        `數量 +${rdef.qtyBonus || 0} ・ 耐久 ${rdef.durability ?? "永久"}`;
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

function buildCraftTab(container, { userId, displayName, profile, craftSub }) {
  if (!CRAFT_SUB_IDS.includes(craftSub)) craftSub = "tools";

  container
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🛠️ ${displayName} 的工坊\n### 🔨 合成`),
    )
    .addActionRowComponents(craftSubRow(userId, craftSub))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 點配方右側「合成」即可打造；舊裝備若仍有耐久會跳出二次確認`,
      ),
    );

  const recipes = craft?.recipes || [];
  const pickaxes = recipes.filter((r) => (r.result?.type || "pickaxe") === "pickaxe");
  const weapons = recipes.filter((r) => r.result?.type === "weapon");
  const rods = recipes.filter((r) => r.result?.type === "rod");
  const repairTools = recipes.filter((r) => r.result?.type === "repair_tool");
  const consumables = recipes.filter((r) => r.result?.type === "fishing_net");
  const appraisalTriggers = recipes.filter((r) => r.result?.type === "stone_appraisal_trigger");
  const farmTools = recipes.filter((r) => r.result?.type === "advanced_trap");
  const treasureMaps = recipes.filter((r) => r.result?.type === "treasure_map");

  if (craftSub === "tools") {
    if (pickaxes.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### ⛏️ 鎬子（採集）"));
      craftableSection(container, pickaxes, profile, "pickaxe", userId);
    }
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
  } else if (craftSub === "battle") {
    if (weapons.length) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent("### ⚔️ 武器（戰鬥）"));
      craftableSection(container, weapons, profile, "weapon", userId);
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
            `### 🪨 賭石碎石回收（持有碎石 **${shardCount}**）\n-# 合成完立刻觸發賭石，10 分鐘內按「立刻賭石」開出，過期就失效`,
          ),
        );
      craftableSection(container, appraisalTriggers, profile, "stone_appraisal_trigger", userId);
    }
    if (farmTools.length) {
      const trapCfg = craft?.advancedTrap || {};
      const fragCount = profile.broken_trap_fragments || 0;
      const usesNow = profile.advanced_trap_uses || 0;
      const cap = trapCfg.maxStack ?? 12;
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### 🪤 農場防護（持有碎片 **${fragCount}**，目前保護 ${usesNow} / ${cap} 次）\n-# 合成即自動生效，被動抵擋下一次農場 raid；達上限多餘的次數會被丟掉`,
          ),
        );
      craftableSection(container, farmTools, profile, "advanced_trap", userId);
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
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 礦石來自 /挖礦，魚來自 /釣魚，✨ 傳說素材碎片來自 /地下城 / BOSS",
    ),
  );
}

// ─── 修復分頁 ────────────────────────────────────────────────────────────────
function buildRepairTab(container, { userId, displayName, profile }) {
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
    const cost = getPickaxeRepairCost(profile);
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
    const cost = getWeaponRepairCost(profile);
    const wKey = profile.weapon || "fist";
    const can =
      cost !== null &&
      wKey !== "fist" &&
      typeof profile.weapon_durability === "number" &&
      typeof profile.weapon_max_durability === "number" &&
      profile.weapon_durability < profile.weapon_max_durability;
    const dura =
      wKey === "fist" || profile.weapon_durability == null
        ? "永久"
        : `${profile.weapon_durability}/${profile.weapon_max_durability ?? "?"} 次`;
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

  // 釣竿
  {
    const cost = getRodRepairCost(profile);
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
async function buildView(client, { userId, guildId, displayName, tab = "equipment", craftSub = "tools" }) {
  if (!TABS.includes(tab)) tab = "equipment";
  const profile = await getOrCreate(client, userId, guildId);

  const container = new ContainerBuilder();
  container.addActionRowComponents(tabRow(userId, tab));
  container.addSeparatorComponents(new SeparatorBuilder());

  if (tab === "equipment") buildEquipmentTab(container, { userId, displayName, profile });
  else if (tab === "craft") buildCraftTab(container, { userId, displayName, profile, craftSub });
  else if (tab === "repair") buildRepairTab(container, { userId, displayName, profile });

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
  CONFIRM_PREFIX,
  CANCEL_PREFIX,
  REPAIR_TOOL_PREFIX,
  TABS,
  CRAFT_SUB_IDS,
};
