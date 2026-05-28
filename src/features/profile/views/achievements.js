require("colors");
const { EmbedBuilder } = require("discord.js");

const gameTitleService = require("../../gameTitles/gameTitleService");

function progressBar(cur, target) {
  const ratio = Math.max(0, Math.min(1, target ? cur / target : 1));
  const filled = Math.round(ratio * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

async function buildAchievementsView(client, { target, guildId }) {
  if (!client.userLevelsCollection) {
    return { content: "🔧 稱號系統尚未啟動！" };
  }

  const userId = target.id;
  const unlocked = await gameTitleService.getUnlocked(client, userId, guildId);
  const rows = await gameTitleService.progress(client, { userId, guildId });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🏆 ${target.username} 的成就`)
    .setFooter({
      text: "👑 礦坑之王為每週挖礦榜第一，用 /挖礦排行 查看本週戰況",
    });

  const byCat = {};
  for (const row of rows) {
    const d = gameTitleService.def(row.id);
    if (!d) continue;
    (byCat[d.category] ||= []).push(row);
  }

  for (const [cat, list] of Object.entries(byCat)) {
    const lines = list.map((row) => {
      const d = gameTitleService.def(row.id);
      const done = unlocked.has(row.id);
      const head = `${done ? "✅" : "⬜"} ${d.emoji || ""} ${d.name || row.id}`.trim();
      if (row.weekly) return `${head} — 每週爭奪`;
      if (done) return head;
      const parts = row.parts
        .map((p) => {
          const cur = Math.min(p.cur, p.target);
          return `${progressBar(p.cur, p.target)} ${p.label} ${cur.toLocaleString()}/${p.target.toLocaleString()}`;
        })
        .join("\n");
      return `${head}\n${parts}`;
    });
    embed.addFields({
      name: gameTitleService.categoryLabel(cat),
      value: lines.join("\n\n"),
      inline: false,
    });
  }

  return { embeds: [embed] };
}

module.exports = { buildAchievementsView };
