const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { survey } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");

const PREFIX = "survey";

function buildSelectRow(userId, question, currentValues) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}_select_${userId}_${question.id}`)
    .setPlaceholder(question.placeholder || question.label)
    .setMinValues(question.min || 1)
    .setMaxValues(question.max || 1);
  for (const opt of question.options) {
    const option = {
      label: opt.label,
      value: opt.value,
      default: Array.isArray(currentValues) && currentValues.includes(opt.value),
    };
    if (opt.emoji) option.emoji = opt.emoji;
    select.addOptions(option);
  }
  return new ActionRowBuilder().addComponents(select);
}

function summarizeAnswer(question, values) {
  if (!Array.isArray(values) || values.length === 0) return "_尚未選擇_";
  const labels = values
    .map((v) => question.options.find((o) => o.value === v))
    .filter(Boolean)
    .map((o) => `${o.emoji || ""}${o.label}`.trim());
  return labels.join("・");
}

function buildSurveyContainer(userId, doc, opts = {}) {
  const answers = doc?.answers || {};
  const openAnswers = doc?.openAnswers || {};

  const container = new ContainerBuilder()
    .setAccentColor(0xf2c037)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📋 ${survey.title}\n${survey.intro}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  for (const q of survey.selectQuestions) {
    container
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${q.label}**${q.required ? "" : "（選填）"}\n-# 目前：${summarizeAnswer(q, answers[q.id])}`,
        ),
      )
      .addActionRowComponents(buildSelectRow(userId, q, answers[q.id]));
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  const openLines = survey.openQuestions.map((q) => {
    const v = openAnswers[q.id];
    const preview = v ? `「${v.length > 40 ? v.slice(0, 40) + "…" : v}」` : "_未填_";
    return `**${q.label}**：${preview}`;
  });
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `### 💬 自由意見（選填）\n${openLines.join("\n")}`,
    ),
  );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_open_${userId}`)
      .setLabel("填寫自由意見")
      .setEmoji("📝")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}_submit_${userId}`)
      .setLabel(`送出問卷（+${survey.reward.toLocaleString()} 幣）`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
  );
  container.addActionRowComponents(buttons);

  if (opts.hint) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${opts.hint}`),
    );
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 完成全部必填題（${survey.selectQuestions.filter((q) => q.required).length} 題）即可領取 **${survey.reward.toLocaleString()}** 幣，問卷僅能填一次。`,
      ),
    );
  }

  return container;
}

function buildOpenModal(userId, doc) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}_modal_${userId}`)
    .setTitle("自由意見");
  for (const q of survey.openQuestions) {
    const input = new TextInputBuilder()
      .setCustomId(q.id)
      .setLabel(q.label)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(Boolean(q.required))
      .setMaxLength(q.max || 500);
    if (q.placeholder) input.setPlaceholder(q.placeholder);
    const existing = doc?.openAnswers?.[q.id];
    if (existing) input.setValue(String(existing).slice(0, q.max || 500));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function buildCompletedContainer(doc, opts = {}) {
  const reward = doc?.rewardAmount ?? survey.reward;
  const lines = [
    `## ✅ 問卷已完成`,
    `感謝你的回饋！**+${reward.toLocaleString()}** ${COIN_EMOJI} 已入帳。`,
  ];
  if (opts.newBalance != null) {
    lines.push(`目前餘額：**${opts.newBalance.toLocaleString()}** ${COIN_EMOJI}`);
  }

  const container = new ContainerBuilder()
    .setAccentColor(0x4caf50)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addSeparatorComponents(new SeparatorBuilder());

  const answers = doc?.answers || {};
  for (const q of survey.selectQuestions) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${q.label}**\n${summarizeAnswer(q, answers[q.id])}`,
      ),
    );
  }

  const openAnswers = doc?.openAnswers || {};
  const openLines = survey.openQuestions
    .map((q) => {
      const v = openAnswers[q.id];
      if (!v) return null;
      return `**${q.label}**\n${v}`;
    })
    .filter(Boolean);
  if (openLines.length > 0) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(openLines.join("\n\n")),
      );
  }

  const footer =
    opts.dmDelivered === false
      ? `-# 你的 DM 似乎關閉了，獎勵照發但收不到感謝訊息～`
      : `-# 你的回答會幫助舒舒決定下一步開發方向。`;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footer));

  return container;
}

function buildClosedContainer(window) {
  const lines = [];
  if (window.reason === "not_started") {
    lines.push(`## 🔒 問卷尚未開放`);
    if (window.startAt) {
      const epoch = Math.floor(window.startAt.getTime() / 1000);
      lines.push(`開放時間：<t:${epoch}:F>（<t:${epoch}:R>）`);
    }
  } else {
    lines.push(`## 🔒 問卷已截止`);
    if (window.endAt) {
      const epoch = Math.floor(window.endAt.getTime() / 1000);
      lines.push(`截止時間：<t:${epoch}:F>（<t:${epoch}:R>）`);
    }
  }
  return new ContainerBuilder()
    .setAccentColor(0x9e9e9e)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        window.reason === "not_started"
          ? `-# 開放後再來填，獎勵 ${survey.reward.toLocaleString()} 幣等你。`
          : `-# 問卷已結束，感謝大家的回饋。`,
      ),
    );
}

function buildThankYouDm(reward, newBalance) {
  const lines = [
    `## ✅ 問卷已收到`,
    survey.thankYouDm || "感謝你填寫逼逼機器人玩家問卷！",
    `\n**+${reward.toLocaleString()}** ${COIN_EMOJI} 已入帳`,
  ];
  if (newBalance != null) {
    lines.push(`目前餘額：**${newBalance.toLocaleString()}** ${COIN_EMOJI}`);
  }
  return new ContainerBuilder()
    .setAccentColor(0x4caf50)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 想看自己的答案可以再執行一次 \`/問卷調查\`。`,
      ),
    );
}

function buildMissingContainer(missing) {
  const lines = missing.map((q) => `• ${q.label}`);
  return new ContainerBuilder()
    .setAccentColor(0xc9302c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ❌ 還有必填題沒答`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `請完成下列題目：\n${lines.join("\n")}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 全部完成後再按「送出問卷」即可領取 ${survey.reward.toLocaleString()} 幣。`,
      ),
    );
}

module.exports = {
  PREFIX,
  buildSurveyContainer,
  buildOpenModal,
  buildCompletedContainer,
  buildMissingContainer,
  buildClosedContainer,
  buildThankYouDm,
};
