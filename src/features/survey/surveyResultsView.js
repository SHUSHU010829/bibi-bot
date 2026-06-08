const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const PREFIX = "srvres";
const BAR_WIDTH = 12;

function bar(pct) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function buildStatsContainer(stats, userId) {
  const { template, total, opened, byQuestion, openEntries } = stats;
  const completionRate = opened > 0 ? Math.round((total / opened) * 100) : 0;

  const container = new ContainerBuilder()
    .setAccentColor(0x4a90e2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📊 問卷統計｜${template.title}\n完成 **${total}** / 已開啟 ${opened} ・ 完成率 ${completionRate}%`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (total === 0) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 還沒有人完成問卷。`),
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}_refresh_${userId}`)
          .setLabel("重新整理")
          .setEmoji("🔄")
          .setStyle(ButtonStyle.Secondary),
      ),
    );
    return container;
  }

  for (const q of template.selectQuestions) {
    const { counts, answered } = byQuestion[q.id] || { counts: {}, answered: 0 };
    const lines = [`**${q.label}**　-# n=${answered}`];
    const sortedOpts = [...q.options].sort(
      (a, b) => (counts[b.value] || 0) - (counts[a.value] || 0),
    );
    for (const opt of sortedOpts) {
      const c = counts[opt.value] || 0;
      const pct = answered > 0 ? (c / answered) * 100 : 0;
      const emoji = opt.emoji ? `${opt.emoji} ` : "";
      lines.push(
        `\`${bar(pct)}\` ${emoji}${opt.label}　**${c}**（${pct.toFixed(0)}%）`,
      );
    }
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n")),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_open_${userId}_0`)
      .setLabel(`查看自由意見（${openEntries.length} 則）`)
      .setEmoji("💬")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(openEntries.length === 0),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_refresh_${userId}`)
      .setLabel("重新整理")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary),
  );
  container.addActionRowComponents(buttons);

  return container;
}

function buildOpenAnswersContainer(stats, page, userId) {
  const { template, openEntries } = stats;
  const total = openEntries.length;
  const idx = Math.max(0, Math.min(page, total - 1));
  const entry = openEntries[idx];

  const container = new ContainerBuilder()
    .setAccentColor(0xf2c037)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## 💬 自由意見　${idx + 1} / ${total}`),
    );

  const epoch = entry?.completedAt
    ? Math.floor(new Date(entry.completedAt).getTime() / 1000)
    : null;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `<@${entry.userId}>　${epoch ? `・ 完成 <t:${epoch}:R>（<t:${epoch}:f>）` : ""}`,
    ),
  );
  container.addSeparatorComponents(new SeparatorBuilder());

  for (const q of template.openQuestions) {
    const v = (entry.openAnswers?.[q.id] || "").trim();
    if (!v) continue;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${q.label}\n${v}`),
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_open_${userId}_${idx - 1}`)
      .setLabel("上一則")
      .setEmoji("◀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx <= 0),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_open_${userId}_${idx + 1}`)
      .setLabel("下一則")
      .setEmoji("▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx >= total - 1),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_stats_${userId}`)
      .setLabel("回統計")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Primary),
  );
  container.addActionRowComponents(nav);

  return container;
}

module.exports = {
  PREFIX,
  buildStatsContainer,
  buildOpenAnswersContainer,
};
