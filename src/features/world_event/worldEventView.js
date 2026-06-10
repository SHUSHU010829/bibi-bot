const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require("discord.js");

const { guildWarehouse, worldEvents } = require("../../config");
const { formatBuff } = require("../buff/buffLabels");

const COLOR_OPEN = 0xf1c40f;
const COLOR_BUFF = 0x2ecc71;
const COLOR_END = 0x95a5a6;
const COLOR_ERROR = 0xe74c3c;
const COLOR_INFO = 0x3498db;

const itemLabel = (id) => guildWarehouse?.items?.[id]?.name || id;
const itemEmoji = (id) => guildWarehouse?.items?.[id]?.emoji || "📦";

function buildHomePanel({ viewerId, events }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🌍 世界事件\n全伺服器共同目標。挖到稀有礦、釣到稀有魚、收草莓、通關地下城時有機率觸發。`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());

  if (events.length === 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 目前沒有進行中的世界事件，去挖礦 / 釣魚 / 種田 / 地下城試試手氣！`
      )
    );
    return c;
  }

  for (const e of events) {
    const reqEntries = Object.entries(e.requirements_total || e.requirements_remaining || {});
    const reqLines = reqEntries
      .map(([k, total]) => {
        const remain = (e.requirements_remaining || {})[k] || 0;
        const filled = total - remain;
        return `• ${itemEmoji(k)} ${itemLabel(k)}　${filled} / ${total}`;
      })
      .join("\n");
    const buffLines = Object.entries(e.rewards?.buffs || {})
      .map(([k, v]) => `-# 達標 buff：${formatBuff(k, v)}`)
      .join("\n");
    const stateTxt =
      e.state === "buffing"
        ? `✅ 達標中（buff 至 <t:${Math.floor(new Date(e.ends_at).getTime() / 1000)}:R>）`
        : `⏳ 募集中（截止 <t:${Math.floor(new Date(e.ends_at).getTime() / 1000)}:R>）`;
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ${e.emoji || "🌍"} ${e.label}\n${e.description || ""}\n\n${stateTxt}\n\n${reqLines}\n${buffLines}`
      )
    );
    if (e.state === "collecting") {
      c.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`we_donate_${viewerId}_${e.event_db_id}`)
            .setLabel(`捐獻物資`)
            .setEmoji("🎁")
            .setStyle(ButtonStyle.Primary)
        )
      );
    }
    c.addSeparatorComponents(new SeparatorBuilder());
  }
  return c;
}

function buildDonatePicker({ viewerId, event }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🎁 捐獻 ${event.emoji || ""} ${event.label}\n選一個物資來捐。系統會優先扣個人背包，不足才扣公會倉庫。`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  const opts = Object.entries(event.requirements_remaining || {})
    .filter(([, v]) => v > 0)
    .slice(0, 25)
    .map(([k, v]) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`${itemLabel(k)}（還缺 ${v}）`)
        .setValue(k)
        .setEmoji(itemEmoji(k))
    );
  if (opts.length === 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 已全數達標，等待 buff 啟動。`)
    );
    return c;
  }
  c.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`we_pick_${viewerId}_${event.event_db_id}`)
        .setPlaceholder("選一個要捐的物資")
        .addOptions(opts)
    )
  );
  return c;
}

function buildQtyPicker({ viewerId, event, itemId, maxPersonal, maxGuild }) {
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  const remain = (event.requirements_remaining || {})[itemId] || 0;
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# 🎁 捐 ${itemEmoji(itemId)} ${itemLabel(itemId)}\n` +
        `事件還缺 ${remain}\n` +
        `你個人背包有 ${maxPersonal}・公會倉庫有 ${maxGuild}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  const totalAvail = Math.min(remain, maxPersonal + maxGuild);
  if (totalAvail <= 0) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# 你和公會倉庫都沒有這個物資。`)
    );
    return c;
  }
  const choices = [1, 10, 50, Math.min(100, totalAvail), totalAvail]
    .filter((v, i, arr) => v > 0 && v <= totalAvail && arr.indexOf(v) === i)
    .slice(0, 5);
  const row = new ActionRowBuilder();
  for (const q of choices) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`we_give_${viewerId}_${event.event_db_id}_${itemId}_${q}`)
        .setLabel(`捐 ${q}`)
        .setStyle(q === totalAvail ? ButtonStyle.Success : ButtonStyle.Primary)
    );
  }
  c.addActionRowComponents(row);
  return c;
}

function buildDonateSuccess({ event, deposited, fromPersonal, fromGuild, itemId, completed, buffEndsAt }) {
  const c = new ContainerBuilder().setAccentColor(completed ? COLOR_BUFF : COLOR_OPEN);
  const sourceLines = [];
  if (fromPersonal > 0) sourceLines.push(`個人背包 -${fromPersonal}`);
  if (fromGuild > 0) sourceLines.push(`公會倉庫 -${fromGuild}`);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ✅ 已捐 ${itemEmoji(itemId)} ${itemLabel(itemId)} ×${deposited}\n${sourceLines.join("・")}`
    )
  );
  c.addSeparatorComponents(new SeparatorBuilder());
  if (completed) {
    const buffLines = Object.entries(event.rewards?.buffs || {})
      .map(([k, v]) => `• ${formatBuff(k, v)}`)
      .join("\n");
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎉 全服達標！\n` +
          `全伺服器 buff 啟動：\n${buffLines}\n` +
          (buffEndsAt
            ? `持續至 <t:${Math.floor(new Date(buffEndsAt).getTime() / 1000)}:R>`
            : "")
      )
    );
  } else {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `事件還缺：\n${Object.entries(event.requirements_remaining || {})
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `• ${itemLabel(k)}：${v}`)
          .join("\n")}`
      )
    );
  }
  return c;
}

function buildSimpleError({ title, body, hint }) {
  const c = new ContainerBuilder()
    .setAccentColor(COLOR_ERROR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  if (hint)
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${hint}`));
  return c;
}

module.exports = {
  buildHomePanel,
  buildDonatePicker,
  buildQtyPicker,
  buildDonateSuccess,
  buildSimpleError,
};
