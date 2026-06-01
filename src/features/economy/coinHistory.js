const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { DateTime } = require("luxon");
const { coinHistory } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");

const BUTTON_PREFIX = "coinhist";
const TZ = "Asia/Taipei";

const PERIOD_LABELS = {
  today: "今日",
  week: "本週",
  month: "本月",
  all: "全部時間",
};

const DIRECTION_LABELS = {
  all: "全部進出",
  in: "📥 入帳",
  out: "📤 出帳",
};

function getDateFilter(period) {
  const now = DateTime.now().setZone(TZ);
  switch (period) {
    case "today":
      return { date: now.toISODate() };
    case "week":
      return { date: { $gte: now.startOf("week").toISODate() } };
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "all":
    default:
      return {};
  }
}

function getCategorySources(category) {
  if (category === "all") return null;
  return coinHistory?.categories?.[category]?.sources || null;
}

function getCategoryLabel(category) {
  if (category === "all") return "全部來源";
  return coinHistory?.categories?.[category]?.label || category;
}

function getSourceLabel(source) {
  return coinHistory?.sourceLabels?.[source] || `❓ ${source}`;
}

function buildMatch({ userId, guildId, direction, category, period }) {
  const match = { userId, guildId, ...getDateFilter(period) };
  const categorySources = getCategorySources(category);
  if (categorySources) match.source = { $in: categorySources };
  if (direction === "in") match.amount = { $gt: 0 };
  if (direction === "out") match.amount = { $lt: 0 };
  return match;
}

async function queryHistory(client, opts) {
  const pageSize = coinHistory?.pageSize || 10;
  const page = Math.max(0, opts.page || 0);
  const match = buildMatch(opts);

  const col = client.coinTransactionsCollection;
  const [rows, summary, total] = await Promise.all([
    col
      .find(match)
      .sort({ createdAt: -1 })
      .skip(page * pageSize)
      .limit(pageSize)
      .toArray(),
    col
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            inflow: {
              $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
            },
            outflow: {
              $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] },
            },
          },
        },
      ])
      .toArray(),
    col.countDocuments(match),
  ]);

  const s = summary[0] || { inflow: 0, outflow: 0 };
  return {
    rows,
    total,
    pageSize,
    page,
    inflow: s.inflow || 0,
    outflow: s.outflow || 0,
  };
}

function formatTimestamp(row) {
  if (row.createdAt) {
    const ts = Math.floor(new Date(row.createdAt).getTime() / 1000);
    return `<t:${ts}:R>`;
  }
  return row.date || "—";
}

function formatRow(row) {
  const amount = row.amount || 0;
  const isIn = amount > 0;
  const sign = isIn ? "+" : "-";
  const arrow = isIn ? "🟢" : "🔴";
  const formatted = `${sign}${Math.abs(amount).toLocaleString()}`.padStart(9);
  const label = getSourceLabel(row.source);
  return `${arrow} \`${formatted}\` ・ ${label} ・ ${formatTimestamp(row)}`;
}

function buildPagerCustomId({ ownerId, direction, category, period, page }) {
  return `${BUTTON_PREFIX}_${ownerId}_${direction}_${category}_${period}_${page}`;
}

function parsePagerCustomId(customId) {
  if (!customId?.startsWith(`${BUTTON_PREFIX}_`)) return null;
  const parts = customId.split("_");
  if (parts.length !== 6) return null;
  const [, ownerId, direction, category, period, pageStr] = parts;
  const page = parseInt(pageStr, 10);
  if (!Number.isFinite(page)) return null;
  return { ownerId, direction, category, period, page };
}

function buildContainer({ result, filters, displayName, ownerId }) {
  const { rows, total, page, pageSize, inflow, outflow } = result;
  const net = inflow + outflow;
  const accent = net >= 0 ? 0x2ecc71 : 0xe74c3c;

  const header =
    `**${displayName}** 的金流紀錄\n` +
    `📅 期間：**${PERIOD_LABELS[filters.period]}** ・ 方向：**${DIRECTION_LABELS[filters.direction]}** ・ 來源：**${getCategoryLabel(filters.category)}**`;

  const summary =
    `🟢 入帳合計：**+${inflow.toLocaleString()}**\n` +
    `🔴 出帳合計：**${outflow.toLocaleString()}**\n` +
    `${net >= 0 ? "📈" : "📉"} 淨額：**${net >= 0 ? "+" : ""}${net.toLocaleString()}** ${MONEY_EMOJI}\n` +
    `🧾 符合條件：共 **${total.toLocaleString()}** 筆`;

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🧾 我的金流紀錄`),
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(summary))
    .addSeparatorComponents(new SeparatorBuilder());

  if (!rows.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        page === 0
          ? "📭 這個條件下沒有任何金流紀錄。\n-# 試著放寬期間或切換方向/來源篩選"
          : "📭 已經是最後一頁了。",
      ),
    );
  } else {
    const listText = rows.map(formatRow).join("\n");
    const pageStart = page * pageSize + 1;
    const pageEnd = page * pageSize + rows.length;
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**第 ${pageStart}–${pageEnd} 筆**（共 ${total.toLocaleString()} 筆）\n${listText}`,
      ),
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 0;
  const hasNext = page + 1 < totalPages;

  if (hasPrev || hasNext) {
    const maxPage = (coinHistory?.maxPage ?? 20) - 1;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          buildPagerCustomId({
            ownerId,
            direction: filters.direction,
            category: filters.category,
            period: filters.period,
            page: Math.max(0, page - 1),
          }),
        )
        .setLabel("較新")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasPrev),
      new ButtonBuilder()
        .setCustomId(`${BUTTON_PREFIX}_noop_${page}_${totalPages}`)
        .setLabel(`第 ${page + 1} / ${Math.min(totalPages, maxPage + 1)} 頁`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(
          buildPagerCustomId({
            ownerId,
            direction: filters.direction,
            category: filters.category,
            period: filters.period,
            page: Math.min(maxPage, page + 1),
          }),
        )
        .setLabel("較舊")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasNext || page >= maxPage),
    );
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addActionRowComponents(row);
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 紀錄保留 90 天 ・ 🟢 入帳 / 🔴 出帳 ・ 想換條件就重新呼叫 \`/我的金流紀錄\``,
      ),
    );

  return container;
}

module.exports = {
  BUTTON_PREFIX,
  PERIOD_LABELS,
  DIRECTION_LABELS,
  queryHistory,
  buildContainer,
  parsePagerCustomId,
  getCategoryLabel,
};
