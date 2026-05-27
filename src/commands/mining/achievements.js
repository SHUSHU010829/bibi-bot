require("colors");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  InteractionContextType,
} = require("discord.js");

const { mining } = require("../../config");
const { getOrCreate } = require("../../features/mining/miningProfile");
const achievementChecker = require("../../features/mining/achievementChecker");
const titleManager = require("../../features/mining/titleManager");

function progressBar(cur, target) {
  const ratio = Math.max(0, Math.min(1, target ? cur / target : 1));
  const filled = Math.round(ratio * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("成就")
    .setDescription("查看你的挖礦成就進度 🏆")
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
      const unlocked = new Set(profile.unlocked_titles || []);

      let coins = 0;
      if (client.userCoinsCollection) {
        const doc = await client.userCoinsCollection
          .findOne({ userId: interaction.user.id, guildId: interaction.guildId })
          .catch(() => null);
        coins = doc?.totalCoins || 0;
      }

      const rows = achievementChecker.progress(profile, coins);

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`🏆 ${interaction.user.username} 的成就`);

      for (const row of rows) {
        const done = unlocked.has(row.id);
        const label = titleManager.titleLabel(row.id);
        const partLines = row.parts.map((p) => {
          const cur = Math.min(p.cur, p.target);
          return `${progressBar(p.cur, p.target)} ${p.label} ${cur.toLocaleString()}/${p.target.toLocaleString()}`;
        });
        embed.addFields({
          name: `${done ? "✅" : "⬜"} ${label}`,
          value: partLines.join("\n"),
          inline: false,
        });
      }

      embed.setFooter({
        text: "👑 礦坑之王為每週挖礦榜第一，用 /挖礦排行 查看本週戰況",
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.log(`[ERROR] /成就:\n${error}\n${error.stack}`.red);
      await interaction.editReply("🔧 查看成就失敗，請呼叫舒舒！").catch(() => {});
    }
  },
};
