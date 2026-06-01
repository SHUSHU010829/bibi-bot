require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, craft, dungeon, fishing } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const { playerAtk } = require("../../features/mining/dungeonService");

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

// 玩家持有某材料數量（傳說碎片走獨立欄位、魚走 fish_bag）。
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
  const def = mining?.ores?.[mat] || {};
  return `${def.emoji || "⛏️"} ${def.name || mat}`;
}

// 把某類型配方渲染進 container。
function addRecipeSection(container, recipes, profile, type) {
  for (const recipe of recipes) {
    const matParts = Object.entries(recipe.materials).map(([mat, need]) => {
      const have = ownedMaterial(profile, mat);
      const ok = have >= need;
      return `${ok ? "✅" : "❌"} ${materialLabel(mat)} ${have}/${need}`;
    });
    const craftable = Object.entries(recipe.materials).every(
      ([mat, need]) => ownedMaterial(profile, mat) >= need
    );
    const resultId = recipe.result?.id;
    if (type === "weapon") {
      const wdef = (dungeon?.weapons || {})[resultId] || {};
      const totalAtk = (dungeon?.baseAtk ?? 20) + (wdef.atk || 0);
      const critPct = Math.round((wdef.critRate || 0) * 100);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${recipe.name}${craftable ? "（可合成）" : ""}**\n` +
            `${weaponLabel(resultId)}\n` +
            matParts.join("\n") +
            `\n屬性：⚔️ 戰鬥力 ${totalAtk}` +
            (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : "") +
            ` ・ 耐久 ${wdef.durability ?? "永久"}`,
        ),
      );
    } else if (type === "rod") {
      const rdef = (fishing?.rods || {})[resultId] || {};
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${recipe.name}${craftable ? "（可合成）" : ""}**\n` +
            `${rodLabel(resultId)}\n` +
            matParts.join("\n") +
            `\n屬性：成功率 +${Math.round((rdef.successBonus || 0) * 100)}% ・ ` +
            `稀有度 +${rdef.rareBonus || 0} ・ ` +
            `CD -${Math.round((rdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
            `數量 +${rdef.qtyBonus || 0} ・ 耐久 ${rdef.durability ?? "永久"}`,
        ),
      );
    } else {
      const pdef = (mining?.pickaxes || {})[resultId] || {};
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${recipe.name}${craftable ? "（可合成）" : ""}**\n` +
            `${pickaxeLabel(resultId)}\n` +
            matParts.join("\n") +
            `\n屬性：luck +${Math.round((pdef.luckBonus || 0) * 100)}% ・ ` +
            `CD -${Math.round((pdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
            `數量 +${pdef.qtyBonus || 0} ・ 耐久 ${pdef.durability ?? "永久"}`,
        ),
      );
    }
  }
}

const CATEGORY_CHOICES = [
  { name: "鎬子", value: "pickaxe" },
  { name: "武器", value: "weapon" },
  { name: "釣竿", value: "rod" },
];

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("裝備")
    .setDescription("查看目前的鎬子、武器與可合成清單 🔧")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("種類")
        .setDescription("只顯示某類合成清單；不選則只看目前裝備")
        .setRequired(false)
        .addChoices(...CATEGORY_CHOICES),
    ),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const category = interaction.options.getString("種類");
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const profile = await getOrCreate(
        client,
        interaction.user.id,
        interaction.guildId
      );

      // ── 目前鎬子 ──
      const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
      const pickDurability =
        profile.pickaxe === "wood" || profile.pickaxe_durability == null
          ? "永久"
          : `${profile.pickaxe_durability} 次`;
      const luckPct = Math.round((pdef.luckBonus || 0) * 100);
      const cdReduceMin = Math.round((pdef.cdReductionMs || 0) / 60000);

      // ── 目前武器 ──
      const wKey = profile.weapon || "fist";
      const wdef = (dungeon?.weapons || {})[wKey] || {};
      const weaponDurability =
        wKey === "fist" || profile.weapon_durability == null
          ? "永久"
          : `${profile.weapon_durability} 次`;
      const critPct = Math.round((wdef.critRate || 0) * 100);
      const atk = playerAtk(profile);
      const weaponNote =
        wKey === "fist"
          ? "（赤手也能打怪但勝率極低，先去合成一把劍！）"
          : "";

      // ── 目前釣竿 ──
      const rodKey = profile.fishing_rod || "bamboo";
      const rdef = (fishing?.rods || {})[rodKey] || {};
      const rodDurability =
        rodKey === "bamboo" || profile.rod_durability == null
          ? "永久"
          : `${profile.rod_durability} 次`;
      const rodSuccessPct = Math.round((rdef.successBonus || 0) * 100);
      const rodCdReduceMin = Math.round((rdef.cdReductionMs || 0) / 60000);

      const statLines = [
        `⛏️ 目前鎬子：**${pickaxeLabel(profile.pickaxe)}**（耐久 ${pickDurability}）`,
        `　屬性：luck +${luckPct}% ・ CD -${cdReduceMin} 分 ・ 數量 +${pdef.qtyBonus || 0}`,
        `⚔️ 目前武器：**${weaponLabel(wKey)}**（耐久 ${weaponDurability}）${weaponNote}`,
        `　戰鬥力：**${atk}**` + (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : ""),
        `🪝 目前釣竿：**${rodLabel(rodKey)}**（耐久 ${rodDurability}）`,
        `　屬性：成功率 +${rodSuccessPct}% ・ 稀有度 +${rdef.rareBonus || 0} ・ CD -${rodCdReduceMin} 分 ・ 數量 +${rdef.qtyBonus || 0}`,
        `✨ 傳說素材碎片：**${profile.legendary_fragments || 0}**`,
      ];

      const container = new ContainerBuilder()
        .setAccentColor(0x95a5a6)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `# 🔧 ${interaction.user.username} 的裝備\n${statLines.join("\n")}`,
          ),
        );

      const recipes = craft?.recipes || [];
      const pickaxeRecipes = recipes.filter(
        (r) => (r.result?.type || "pickaxe") === "pickaxe"
      );
      const weaponRecipes = recipes.filter((r) => r.result?.type === "weapon");
      const rodRecipes = recipes.filter((r) => r.result?.type === "rod");

      if (category === "pickaxe" && pickaxeRecipes.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("### ⛏️ 鎬子（採集）"),
          );
        addRecipeSection(container, pickaxeRecipes, profile, "pickaxe");
      }

      if (category === "weapon" && weaponRecipes.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("### ⚔️ 武器（戰鬥）"),
          );
        addRecipeSection(container, weaponRecipes, profile, "weapon");
      }

      if (category === "rod" && rodRecipes.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("### 🎣 釣竿（釣魚）"),
          );
        addRecipeSection(container, rodRecipes, profile, "rod");
      }

      const footer = category
        ? "-# 用 /合成 打造；礦石來自 /挖礦，魚來自 /釣魚，傳說素材碎片來自 /地下城"
        : "-# 想看合成清單請選「種類」參數：鎬子 / 武器 / 釣竿";
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(footer),
      );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      console.log(`[ERROR] /裝備:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看裝備失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
