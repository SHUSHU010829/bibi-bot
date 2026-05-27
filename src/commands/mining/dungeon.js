require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const dungeonService = require("../../features/mining/dungeonService");
const { COIN_EMOJI } = require("../../constants/coin");

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("地下城")
    .setDescription("消耗體力深入地下城戰鬥，勝利可獲得礦石、金幣或傳說素材 ⚔️")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      const result = await dungeonService.enterDungeon(client, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        member: interaction.member,
        username: interaction.user.username,
      });

      if (!result.ok) {
        if (result.reason === "disabled") {
          return interaction.editReply("🔧 地下城系統尚未啟動！");
        }
        if (result.reason === "no_stamina") {
          const tail = result.nextRegenAt
            ? `\n下一點體力：<t:${Math.floor(result.nextRegenAt / 1000)}:R>`
            : "";
          return interaction.editReply(
            `😮‍💨 體力耗盡了（0/${result.max}）！每小時回復 1 點，休息一下再來。${tail}`
          );
        }
        return interaction.editReply("🔧 進地下城失敗，請稍後再試。");
      }

      const m = result.monster;
      const winPct = Math.round(result.winRate * 100);
      const staminaLine = `🔋 體力：${result.stamina}/${result.staminaMax}`;

      if (!result.won) {
        const embed = new EmbedBuilder()
          .setColor(0xe74c3c)
          .setTitle("💀 戰鬥失敗")
          .setDescription(
            `你遭遇了 **${m.emoji} ${m.name}**（HP ${m.hp}）！\n` +
              `你的攻擊力 **${result.atk}**，勝率 **${winPct}%**…可惜這次落敗了，空手而歸。`
          )
          .addFields(
            { name: "狀態", value: staminaLine, inline: true },
            {
              name: "累積探索",
              value: `${result.dungeonCount.toLocaleString()} 次`,
              inline: true,
            }
          )
          .setFooter({ text: "合成更好的鎬子能提升攻擊力，提高勝率！" });
        return interaction.editReply({ embeds: [embed] });
      }

      // 勝利戰利品描述
      let rewardLine;
      if (result.loot.id === "ore_fragment" && result.oreGained) {
        if (result.oreOverflowToCoins) {
          rewardLine =
            `🎒 背包已滿！戰利品 ${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty} ` +
            `折算成 **+${result.coinsGained.toLocaleString()}** ${COIN_EMOJI}`;
        } else {
          rewardLine = `掉落 **${oreLabel(result.oreGained.ore)} ×${result.oreGained.qty}**！`;
        }
      } else if (result.loot.id === "coins") {
        rewardLine = `掉落 **+${result.coinsGained.toLocaleString()}** ${COIN_EMOJI}！`;
      } else if (result.loot.id === "legendary_fragment") {
        rewardLine = `掉落 **✨ 傳說素材碎片 ×${result.legendaryGained}**！（未來合成用，好好收著）`;
      } else {
        rewardLine = "雖然贏了，但這次什麼都沒掉落…運氣差了點。";
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("⚔️ 戰鬥勝利！")
        .setDescription(
          `你擊敗了 **${m.emoji} ${m.name}**（HP ${m.hp}）！\n` +
            `攻擊力 **${result.atk}** ・ 勝率 **${winPct}%**\n\n${rewardLine}`
        )
        .addFields(
          { name: "狀態", value: staminaLine, inline: true },
          {
            name: "累積探索",
            value: `${result.dungeonCount.toLocaleString()} 次`,
            inline: true,
          }
        );

      if (result.balance != null) {
        embed.addFields({
          name: "目前餘額",
          value: `${result.balance.toLocaleString()} ${COIN_EMOJI}`,
          inline: true,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /地下城:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 地下城探索失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
