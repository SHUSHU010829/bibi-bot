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

const { formatBuff } = require("../buff/buffLabels");
const { itemLabel, itemEmoji } = require("./worldEventItems");

const COLOR_OPEN = 0xf1c40f;
const COLOR_BUFF = 0x2ecc71;
const COLOR_END = 0x95a5a6;
const COLOR_ERROR = 0xe74c3c;
const COLOR_INFO = 0x3498db;

// 主線活動要跑好幾天，只印 "3200 / 10000" 很難一眼看出進度，補一條視覺條。
function progressBar(filled, total, width = 12) {
  if (!total || total <= 0) return "";
  const ratio = Math.max(0, Math.min(1, filled / total));
  const on = Math.round(ratio * width);
  return `${"█".repeat(on)}${"░".repeat(width - on)} ${Math.floor(ratio * 100)}%`;
}

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
        const head = `• ${itemEmoji(k)} ${itemLabel(k)}　${filled.toLocaleString()} / ${total.toLocaleString()}`;
        return e.kind === "mainline" ? `${head}\n\`${progressBar(filled, total)}\`` : head;
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
            .setCustomId(`we_donate|${viewerId}|${e.event_db_id}`)
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
        .setCustomId(`we_pick|${viewerId}|${event.event_db_id}`)
        .setPlaceholder("選一個要捐的物資")
        .addOptions(opts)
    )
  );
  return c;
}

function buildQtyPicker({
  viewerId,
  event,
  itemId,
  maxPersonal,
  maxGuild,
  dailyLimit = 0,
  usedToday = 0,
}) {
  const n = (v) => (v || 0).toLocaleString();
  const c = new ContainerBuilder().setAccentColor(COLOR_INFO);
  const remain = (event.requirements_remaining || {})[itemId] || 0;
  const roomToday = dailyLimit > 0 ? Math.max(0, dailyLimit - usedToday) : Infinity;

  // 逼幣扣的是錢包、公會金庫捐不出來，講「背包 / 公會倉庫」會誤導
  const isCurrency = itemId === "coins";
  const headLines = [
    `# 🎁 捐 ${itemEmoji(itemId)} ${itemLabel(itemId)}`,
    `事件還缺 ${n(remain)}`,
    isCurrency
      ? `你的錢包有 ${n(maxPersonal)}`
      : `你個人背包有 ${n(maxPersonal)}・公會倉庫有 ${n(maxGuild)}`,
  ];
  if (dailyLimit > 0) {
    headLines.push(`今日額度 ${n(usedToday)} / ${n(dailyLimit)}（還可投入 ${n(roomToday)}）`);
  }
  c.addTextDisplayComponents(new TextDisplayBuilder().setContent(headLines.join("\n")));
  c.addSeparatorComponents(new SeparatorBuilder());

  // 每日上限也要夾進去，否則會給出按了必被 daily_limit 打回來的按鈕
  const totalAvail = Math.min(remain, maxPersonal + maxGuild, roomToday);
  if (totalAvail <= 0) {
    const body =
      roomToday <= 0
        ? `-# 今天的${itemLabel(itemId)}額度已用完，明天 00:00（台北）重置。`
        : isCurrency
          ? `-# 你的錢包沒有足夠的逼幣。`
          : `-# 你和公會倉庫都沒有這個物資。`;
    c.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    return c;
  }
  // 逼幣的量級跟礦石差兩三個數量級，1/10/50 這種級距按到天荒地老
  const steps = itemId === "coins" ? [1000, 10000, 50000] : [1, 10, 50];
  const choices = [...steps, Math.min(steps[2] * 2, totalAvail), totalAvail]
    .filter((v, i, arr) => v > 0 && v <= totalAvail && arr.indexOf(v) === i)
    .slice(0, 5);
  const row = new ActionRowBuilder();
  for (const q of choices) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`we_give|${viewerId}|${event.event_db_id}|${itemId}|${q}`)
        .setLabel(`捐 ${n(q)}`)
        .setStyle(q === totalAvail ? ButtonStyle.Success : ButtonStyle.Primary)
    );
  }
  c.addActionRowComponents(row);
  if (dailyLimit > 0 && totalAvail === roomToday && roomToday < maxPersonal + maxGuild) {
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 最大值 ${n(roomToday)} 是今天剩下的額度，不是你的全部庫存`
      )
    );
  }
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
