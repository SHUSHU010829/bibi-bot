require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");

const { BADGES, BADGE_CATEGORIES } = require("../../leveling/badgeDefinitions");

async function run(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const doc = await client.userLevelsCollection?.findOne({
      userId: interaction.user.id,
      guildId: interaction.guildId,
    });
    const owned = new Set(doc?.badges || []);

    const container = new ContainerBuilder()
      .setAccentColor(0xd4a437)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏅 徽章圖鑑\n已解鎖 **${owned.size} / ${BADGES.length}**`
        )
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
      );

    for (const [catKey, catLabel] of Object.entries(BADGE_CATEGORIES)) {
      const catBadges = BADGES.filter((b) => b.category === catKey);
      if (catBadges.length === 0) continue;

      const lines = catBadges.map((b) => {
        const has = owned.has(b.id);
        if (has) {
          return `${b.emoji} **${b.name}** — ${b.description}`;
        }
        let progressStr = "";
        let nameDecoration = b.name;
        if (typeof b.progress === "function") {
          try {
            const { current, target } = b.progress(doc || {}) || {};
            if (typeof current === "number" && typeof target === "number" && target > 0) {
              const pct = Math.min(100, Math.floor((current / target) * 100));
              const close = pct >= 80;
              progressStr = `  (${current.toLocaleString()}/${target.toLocaleString()} · ${pct}%)`;
              if (close) {
                progressStr = ` ⚡${progressStr}`;
                nameDecoration = `**${b.name}**`;
              }
            }
          } catch {
            /* ignore */
          }
        }
        return `🔒 ${nameDecoration} — ${b.description}${progressStr}`;
      });

      container
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### ${catLabel}\n${lines.join("\n")}`
          )
        )
        .addSeparatorComponents(new SeparatorBuilder());
    }

    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 🔒 = 未解鎖 ・ 用 \`/稱號 設定\` 把已解鎖徽章設成等級卡稱號`
      )
    );

    await interaction.editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.log(`[ERROR] /level badges:\n${error}\n${error.stack}`.red);
    await interaction
      .editReply("🔧 載入徽章圖鑑失敗，請呼叫舒舒！")
      .catch(() => {});
  }
}

module.exports = { run };
