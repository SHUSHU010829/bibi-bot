require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { mining, craft } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");

function pickaxeLabel(key) {
  const def = mining?.pickaxes?.[key] || {};
  return `${def.emoji || "⛏️"} ${def.name || key}`;
}

function oreLabel(mat) {
  const def = mining?.ores?.[mat] || {};
  return `${def.emoji || "⛏️"} ${def.name || mat}`;
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("equipment")
    .setDescription("查看目前裝備與可合成的鎬子 🔧")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!mining?.enabled || !client.miningProfilesCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const profile = await getOrCreate(
        client,
        interaction.user.id,
        interaction.guildId
      );
      const backpack = profile.backpack || {};

      const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
      const durabilityText =
        profile.pickaxe === "wood" || profile.pickaxe_durability == null
          ? "永久"
          : `${profile.pickaxe_durability} 次`;

      const luckPct = Math.round((pdef.luckBonus || 0) * 100);
      const cdReduceMin = Math.round((pdef.cdReductionMs || 0) / 60000);
      const statLines = [
        `目前鎬子：**${pickaxeLabel(profile.pickaxe)}**`,
        `耐久：**${durabilityText}**`,
        `屬性：luck +${luckPct}% ・ CD -${cdReduceMin} 分 ・ 數量 +${pdef.qtyBonus || 0}`,
      ];

      const embed = new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle(`🔧 ${interaction.user.username} 的裝備`)
        .setDescription(statLines.join("\n"));

      for (const recipe of craft?.recipes || []) {
        const matParts = Object.entries(recipe.materials).map(([mat, need]) => {
          const have = backpack[mat] || 0;
          const ok = have >= need;
          return `${ok ? "✅" : "❌"} ${oreLabel(mat)} ${have}/${need}`;
        });
        const craftable = Object.entries(recipe.materials).every(
          ([mat, need]) => (backpack[mat] || 0) >= need
        );
        const targetPdef = mining.pickaxes[recipe.result?.id] || {};
        embed.addFields({
          name: `${recipe.emoji || ""} ${recipe.name}${craftable ? "（可合成）" : ""}`,
          value:
            matParts.join("\n") +
            `\n屬性：luck +${Math.round((targetPdef.luckBonus || 0) * 100)}% ・ ` +
            `CD -${Math.round((targetPdef.cdReductionMs || 0) / 60000)} 分 ・ ` +
            `數量 +${targetPdef.qtyBonus || 0} ・ 耐久 ${targetPdef.durability ?? "永久"}`,
          inline: false,
        });
      }

      embed.setFooter({ text: "用 /craft [裝備] 合成；材料來自 /mine 挖到的礦石" });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /equipment:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看裝備失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
