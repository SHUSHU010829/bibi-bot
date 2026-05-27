require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const {
  getOrCreate,
  backpackCapacity,
  backpackUsed,
} = require("../../features/mining/miningProfile");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("礦袋")
    .setDescription("查看你的礦石背包與挖礦狀態 🎒")
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
      const cap = backpackCapacity(profile, mining);
      const used = backpackUsed(profile);

      const oreLines = [];
      let totalValue = 0;
      for (const [key, def] of Object.entries(mining.ores)) {
        const qty = profile.backpack?.[key] || 0;
        const value = qty * (def.price || 0);
        totalValue += value;
        oreLines.push(
          `${def.emoji || "⛏️"} **${def.name}** ×${qty}` +
            (qty > 0 ? ` ・ ${value.toLocaleString()} 🪙` : "")
        );
      }

      const pdef = mining.pickaxes[profile.pickaxe] || mining.pickaxes.wood;
      const durabilityText =
        profile.pickaxe === "wood" || profile.pickaxe_durability == null
          ? "永久"
          : `耐久 ${profile.pickaxe_durability} 次`;

      const now = Date.now();
      const cdText =
        (profile.mine_cooldown_at || 0) > now
          ? `<t:${Math.floor(profile.mine_cooldown_at / 1000)}:R>`
          : "✅ 現在可挖礦";

      const embed = new EmbedBuilder()
        .setColor(0xd2a679)
        .setTitle(`🎒 ${interaction.user.username} 的礦石背包`)
        .setDescription(oreLines.join("\n"))
        .addFields(
          {
            name: "背包容量",
            value: `${used} / ${cap}`,
            inline: true,
          },
          {
            name: "全部賣出可得",
            value: `${totalValue.toLocaleString()} 🪙`,
            inline: true,
          },
          {
            name: "目前鎬子",
            value: `${pdef.emoji || "⛏️"} ${pdef.name}（${durabilityText}）`,
            inline: false,
          },
          { name: "挖礦狀態", value: cdText, inline: true },
          {
            name: "道具",
            value:
              `🍀 幸運藥水 ×${profile.luck_potion_uses || 0} ・ ` +
              `🎫 CD 縮短券 ×${profile.cd_ticket_count || 0}`,
            inline: false,
          }
        )
        .setFooter({ text: "用 /賣礦 換金幣，或 /合成 打造更好的鎬子" });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /礦袋:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看背包失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
