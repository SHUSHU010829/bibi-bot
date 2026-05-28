require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const gameTitleService = require("../../gameTitles/gameTitleService");
const {
  BADGES,
  BADGE_CATEGORIES,
} = require("../../leveling/badgeDefinitions");

function progressBar(cur, target) {
  const ratio = Math.max(0, Math.min(1, target ? cur / target : 1));
  const filled = Math.round(ratio * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// 同時呈現「等級徽章」與「遊戲稱號」兩類成就：
// - 等級徽章來自 features/leveling/badgeDefinitions
// - 遊戲稱號來自 features/gameTitles/gameTitleService
async function buildAchievementsView(client, { target, member, guildId }) {
  if (!client.userLevelsCollection) {
    return { content: "🔧 等級／成就系統尚未啟動！" };
  }

  const userId = target.id;

  const [levelDoc, gtUnlocked, gtProgress] = await Promise.all([
    client.userLevelsCollection.findOne({ userId, guildId }),
    gameTitleService.getUnlocked(client, userId, guildId),
    gameTitleService.progress(client, { userId, guildId }),
  ]);

  const ownedBadges = new Set(levelDoc?.badges || []);
  const badgeUnlocked = ownedBadges.size;
  const badgeTotal = BADGES.length;
  const gtTotalCount = gameTitleService.order().length;
  const gtUnlockedCount = gtUnlocked.size;

  const totalUnlocked = badgeUnlocked + gtUnlockedCount;
  const totalTotal = badgeTotal + gtTotalCount;

  const displayName = member?.displayName || target.username;
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 🏆 ${displayName} 的成就\n` +
          `已解鎖 **${totalUnlocked} / ${totalTotal}**\n` +
          `-# 🏅 等級徽章 ${badgeUnlocked}/${badgeTotal} ・ 🎮 遊戲稱號 ${gtUnlockedCount}/${gtTotalCount}`
      )
    );

  // ── 等級徽章區 ──
  for (const [catKey, catLabel] of Object.entries(BADGE_CATEGORIES)) {
    const catBadges = BADGES.filter((b) => b.category === catKey);
    if (catBadges.length === 0) continue;

    const lines = catBadges.map((b) => {
      const has = ownedBadges.has(b.id);
      if (has) return `✅ ${b.emoji} **${b.name}** — ${b.description}`;

      let progressStr = "";
      let nameDecoration = b.name;
      if (typeof b.progress === "function") {
        try {
          const { current, target: tg } = b.progress(levelDoc || {}) || {};
          if (typeof current === "number" && typeof tg === "number" && tg > 0) {
            const pct = Math.min(100, Math.floor((current / tg) * 100));
            const close = pct >= 80;
            progressStr = `  (${current.toLocaleString()}/${tg.toLocaleString()} · ${pct}%)`;
            if (close) {
              progressStr = ` ⚡${progressStr}`;
              nameDecoration = `**${b.name}**`;
            }
          }
        } catch {
          /* 進度算錯不影響列表 */
        }
      }
      return `🔒 ${nameDecoration} — ${b.description}${progressStr}`;
    });

    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${catLabel}\n${lines.join("\n")}`.slice(0, 4000)
      )
    );
  }

  // ── 遊戲稱號區 ──
  const byCat = {};
  for (const row of gtProgress) {
    const d = gameTitleService.def(row.id);
    if (!d) continue;
    (byCat[d.category] ||= []).push(row);
  }

  for (const [cat, list] of Object.entries(byCat)) {
    const lines = list.map((row) => {
      const d = gameTitleService.def(row.id);
      const done = gtUnlocked.has(row.id);
      const head = `${done ? "✅" : "🔒"} ${d.emoji || ""} ${d.name || row.id}`.trim();
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
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `### ${gameTitleService.categoryLabel(cat)}\n${lines.join("\n\n")}`.slice(
          0,
          4000
        )
      )
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 👑 礦坑之王為每週挖礦榜第一 ・ 用 /稱號 設定 把成就掛上等級卡"
    )
  );

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = { buildAchievementsView };
