require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, craft, dungeon } = require("../../config");
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

// 玩家持有某材料數量（傳說碎片走獨立欄位）。
function ownedMaterial(profile, mat) {
  if (mat === "legendary_fragment") return profile.legendary_fragments || 0;
  return (profile.backpack || {})[mat] || 0;
}

function materialLabel(mat) {
  if (mat === "legendary_fragment") return "✨ 傳說素材碎片";
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName("裝備")
    .setDescription("查看目前的鎬子、武器與可合成清單 🔧")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
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

      const statLines = [
        `⛏️ 目前鎬子：**${pickaxeLabel(profile.pickaxe)}**（耐久 ${pickDurability}）`,
        `　屬性：luck +${luckPct}% ・ CD -${cdReduceMin} 分 ・ 數量 +${pdef.qtyBonus || 0}`,
        `⚔️ 目前武器：**${weaponLabel(wKey)}**（耐久 ${weaponDurability}）${weaponNote}`,
        `　戰鬥力：**${atk}**` + (critPct > 0 ? ` ・ ⚡ 暴擊 ${critPct}%` : ""),
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

      if (pickaxeRecipes.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("### ⛏️ 鎬子（採集）"),
          );
        addRecipeSection(container, pickaxeRecipes, profile, "pickaxe");
      }

      if (weaponRecipes.length) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("### ⚔️ 武器（戰鬥）"),
          );
        addRecipeSection(container, weaponRecipes, profile, "weapon");
      }

      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "-# 用 /合成 打造；礦石來自 /挖礦，傳說素材碎片來自 /地下城",
        ),
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
