const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
} = require("discord.js");

const { countdown: cfg } = require("../../config");
const { daysUntil, isIntervalMode, intervalLabel } = require("./countdownService");

const COLORS = () => cfg?.colors || {};

function epoch(targetAt) {
  return Math.floor(new Date(targetAt).getTime() / 1000);
}

function whenLine(targetAt) {
  const e = epoch(targetAt);
  return `📅 <t:${e}:F>（<t:${e}:R>）`;
}

function ts(at, style = "f") {
  return `<t:${epoch(at)}:${style}>`;
}

function periodLine(doc) {
  return `📅 ${ts(doc.startAt)} ～ ${ts(doc.endAt)}`;
}

// 期間提醒建立成功的確認卡。
function buildIntervalRegisteredContainer(doc, plan) {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS().interval ?? 0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🔔 已建立期間提醒：${doc.title}`),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (doc.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(doc.description),
    );
  }
  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        [
          periodLine(doc),
          `⏱️ ${intervalLabel(doc.intervalMinutes)}提醒一次，共 **${plan.remaining}** 次`,
          `下一次：${ts(doc.nextAt)}（${ts(doc.nextAt, "R")}）`,
        ].join("\n"),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 時間到我會在這個頻道發送提醒；用 `/倒數 刪除` 可以提前停止。",
      ),
    );
  return container;
}

// 期間提醒每次到點的播報卡。
function buildIntervalAnnouncementContainer(doc, claim) {
  const container = new ContainerBuilder()
    .setAccentColor(
      claim.isLast ? COLORS().arrival ?? 0x57f287 : COLORS().interval ?? 0x9b59b6,
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🔔 ${doc.title}`),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (doc.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(doc.description),
    );
  }
  const progress = `第 ${Math.min(claim.index, claim.total)}／${claim.total} 次提醒`;
  const tail = claim.isLast
    ? "這是最後一次提醒，期間提醒已結束。"
    : `下一次：${ts(claim.nextAt)}（${ts(claim.nextAt, "R")}）`;
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`${periodLine(doc)}\n-# ${progress}・${tail}`),
  );
  return container;
}

// 建立成功後回給管理員的確認卡。
function buildRegisteredContainer(doc) {
  const left = daysUntil(doc.targetAt);
  const container = new ContainerBuilder()
    .setAccentColor(COLORS().create ?? 0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ⏳ 已建立倒數：${doc.title}`),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (doc.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(doc.description),
    );
  }
  container
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${whenLine(doc.targetAt)}\n還剩 **${left}** 天`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 我會在剩 30／14／7／3／1 天以及當天，自動在這個頻道提醒。",
      ),
    );
  return container;
}

// 里程碑 / 到期當天的自動播報卡。
function buildAnnouncementContainer(doc, kind, days) {
  const isArrival = kind === "arrival";
  const urgent = !isArrival && days <= 3;
  const color = isArrival
    ? COLORS().arrival ?? 0x57f287
    : urgent
      ? COLORS().urgent ?? 0xe74c3c
      : COLORS().milestone ?? 0xf1c40f;

  const title = isArrival
    ? `# 🎉 ${doc.title} — 今天就是這天！`
    : `# ⏰ ${doc.title} — 倒數 ${days} 天`;

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(new SeparatorBuilder());

  if (doc.description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(doc.description),
    );
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(whenLine(doc.targetAt)),
  );
  return container;
}

// 管理員 /倒數 列表 的卡片。
function buildListContainer(docs) {
  const container = new ContainerBuilder()
    .setAccentColor(COLORS().create ?? 0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# ⏳ 進行中的倒數 / 期間提醒"),
    )
    .addSeparatorComponents(new SeparatorBuilder());

  if (!docs.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "目前沒有任何倒數。\n-# 用 `/倒數 新增` 建立第一個吧。",
      ),
    );
    return container;
  }

  for (const doc of docs) {
    if (isIntervalMode(doc)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**${doc.title}** — 🔔 期間提醒・${intervalLabel(doc.intervalMinutes)}\n${periodLine(doc)}　<#${doc.channelId}>\n下一次：${ts(doc.nextAt, "R")}\n-# ID：\`${doc._id}\``,
        ),
      );
      continue;
    }
    const left = daysUntil(doc.targetAt);
    const leftLabel = left <= 0 ? "今天到期" : `還剩 ${left} 天`;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**${doc.title}** — ${leftLabel}\n${whenLine(doc.targetAt)}　<#${doc.channelId}>\n-# ID：\`${doc._id}\``,
      ),
    );
  }
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 用 `/倒數 刪除 <ID>` 移除某個倒數。"),
  );
  return container;
}

module.exports = {
  buildRegisteredContainer,
  buildAnnouncementContainer,
  buildListContainer,
  buildIntervalRegisteredContainer,
  buildIntervalAnnouncementContainer,
};
