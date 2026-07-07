const { DateTime } = require("luxon");

function getDateFilter(period) {
  const now = DateTime.now().setZone("Asia/Taipei");
  switch (period) {
    case "today":
      return { date: now.toISODate() };
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "week":
    default:
      return { date: { $gte: now.startOf("week").toISODate() } };
  }
}

function describeRange(range) {
  if (!range?.firstDate || !range?.lastDate) return "無資料";
  const first = DateTime.fromISO(range.firstDate, { zone: "Asia/Taipei" });
  const last = DateTime.fromISO(range.lastDate, { zone: "Asia/Taipei" });
  const days = Math.max(1, Math.round(last.diff(first, "days").days) + 1);
  if (range.firstDate === range.lastDate) {
    return `${range.firstDate}・共 1 天`;
  }
  return `${range.firstDate} ~ ${range.lastDate}・共 ${days} 天`;
}

async function fetchCasino(client, { guildId, period }, kind) {
  if (!client.coinTransactionsCollection) {
    return { rows: [], total: 0, disabled: "🔧 金幣系統尚未啟動" };
  }

  const sort = kind === "winners" ? -1 : 1;
  const profitFilter =
    kind === "winners"
      ? { netProfit: { $gt: 0 } }
      : { netProfit: { $lt: 0 } };

  const baseMatch = {
    guildId,
    source: { $in: ["bet", "payout"] },
    "meta.game": { $ne: "redPacket" },
    ...getDateFilter(period),
  };

  const [data, rangeAgg] = await Promise.all([
    client.coinTransactionsCollection
      .aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: "$userId",
            netProfit: { $sum: "$amount" },
            totalWagered: {
              $sum: {
                $cond: [{ $eq: ["$source", "bet"] }, { $abs: "$amount" }, 0],
              },
            },
            totalPayout: {
              $sum: {
                $cond: [{ $eq: ["$source", "payout"] }, "$amount", 0],
              },
            },
          },
        },
        { $match: profitFilter },
        { $sort: { netProfit: sort } },
        { $limit: 10 },
      ])
      .toArray(),
    client.coinTransactionsCollection
      .aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: null,
            firstDate: { $min: "$date" },
            lastDate: { $max: "$date" },
          },
        },
      ])
      .toArray(),
  ]);

  const rows = data.map((u) => {
    const sign = u.netProfit >= 0 ? "+" : "";
    return {
      id: u._id,
      mention: `<@${u._id}>`,
      detail:
        `**${sign}${u.netProfit.toLocaleString()}** credits\n` +
        `-# 下注 ${u.totalWagered.toLocaleString()} ・ 派彩 ${u.totalPayout.toLocaleString()}`,
    };
  });

  const range = rangeAgg[0]
    ? { firstDate: rangeAgg[0].firstDate, lastDate: rangeAgg[0].lastDate }
    : null;
  const rangeText = describeRange(range);

  return {
    rows,
    total: rows.length,
    footer:
      `統計範圍：拉霸、21 點、HI-LO、輪盤、骰寶、德州撲克、樂透（${rangeText}）` +
      "・交易紀錄最多保留 30 天",
    emptyHint:
      kind === "winners"
        ? "📊 這個期間還沒有人在賭場賺到錢"
        : "📊 這個期間還沒有人在賭場賠錢",
  };
}

async function fetchCasinoWinners(client, ctx) {
  return fetchCasino(client, ctx, "winners");
}

async function fetchCasinoLosers(client, ctx) {
  return fetchCasino(client, ctx, "losers");
}

module.exports = { fetchCasinoWinners, fetchCasinoLosers };
