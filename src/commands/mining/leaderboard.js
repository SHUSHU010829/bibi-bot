require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const rankService = require("../../features/mining/rankService");

const MEDALS = ["🥇", "🥈", "🥉"];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("挖礦排行")
    .setDescription("本週挖礦數量排行榜，週一重置並頒發礦坑之王 👑")
    .setContexts(InteractionContextType.Guild),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!mining?.enabled || !client.mineLogsCollection) {
        return interaction.editReply("🔧 挖礦系統尚未啟動！");
      }

      const ranking = await rankService.currentWeekRanking(
        client,
        interaction.guildId,
        10
      );

      if (!ranking.length) {
        return interaction.editReply(
          "📊 本週還沒有人挖礦，快用 `/挖礦` 搶下第一個礦坑之王 👑！"
        );
      }

      const { end } = rankService.currentWeekWindow();
      const resetEpoch = Math.floor(end.getTime() / 1000);

      const lines = ranking.map((r, i) => {
        const rank = MEDALS[i] || `**${i + 1}.**`;
        return `${rank} <@${r.userId}> — **${r.total.toLocaleString()}** 顆（${r.count} 次）`;
      });

      const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle("👑 本週挖礦排行榜")
        .setDescription(lines.join("\n"))
        .setFooter({ text: "依本週採礦總數量排名" })
        .addFields({
          name: "本週結算",
          value: `<t:${resetEpoch}:R>（週一 00:01 頒發礦坑之王）`,
        });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /挖礦排行:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看排行榜失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
