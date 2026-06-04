require("colors");
const { DateTime } = require("luxon");

const TZ = "Asia/Taipei";

// source 分類（與 grantCoins.js 同步維護）
const PURE_MINT_SOURCES = new Set([
  "mining_sell", "work", "dungeon", "welfare",
  "message", "voice", "reaction",
  "quest_daily", "quest_weekly", "quest_event",
  "stock_dividend", "invite_reward", "invite_welcome",
  "donation", "encounter",
  "farm_harvest", "farm_raid", "farm_sell",
  "boss_loot", "boss_killer", "boss_kill_bonus",
  "guild_create_refund", "guild_donate_refund", "guild_disband_payout",
]);
const PURE_SINK_SOURCES = new Set([
  "shop_buy", "wealth_tax", "stock_fee", "stone_appraisal",
  "farm_plant", "farm_expand", "barter_fee",
  "guild_create", "guild_donate",
  "invite_clawback",
]);

function todayIso() {
  return DateTime.now().setZone(TZ).toISODate();
}

function isoDaysAgo(n) {
  return DateTime.now().setZone(TZ).minus({ days: n }).toISODate();
}

function dateRangeIso(daysBack) {
  const out = [];
  for (let i = daysBack - 1; i >= 0; i -= 1) out.push(isoDaysAgo(i));
  return out;
}

// 從 CoinTransactions 即時聚合指定 guild、指定日期區間的每日 flow。
// 回傳：{ days: [{date, mintedTotal, burnedTotal, netFlow, mintedBySource, burnedBySource}], totals: {...} }
async function aggregateFlow(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) {
    return { days: [], totals: { mintedTotal: 0, burnedTotal: 0, netFlow: 0 } };
  }
  const rows = await client.coinTransactionsCollection
    .aggregate([
      { $match: { guildId, date: { $gte: fromIso, $lte: toIso } } },
      {
        $group: {
          _id: { date: "$date", source: "$source" },
          positive: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
          negative: { $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] } },
        },
      },
    ])
    .toArray();

  const byDate = new Map();
  for (const r of rows) {
    const { date, source } = r._id;
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        mintedTotal: 0,
        burnedTotal: 0,
        netFlow: 0,
        mintedBySource: {},
        burnedBySource: {},
      });
    }
    const day = byDate.get(date);
    if (r.positive > 0) {
      day.mintedBySource[source] = (day.mintedBySource[source] || 0) + r.positive;
      day.mintedTotal += r.positive;
    }
    if (r.negative < 0) {
      const burned = -r.negative;
      day.burnedBySource[source] = (day.burnedBySource[source] || 0) + burned;
      day.burnedTotal += burned;
    }
  }
  for (const day of byDate.values()) {
    day.netFlow = day.mintedTotal - day.burnedTotal;
  }

  const days = [];
  let cursor = DateTime.fromISO(fromIso, { zone: TZ });
  const end = DateTime.fromISO(toIso, { zone: TZ });
  while (cursor <= end) {
    const d = cursor.toISODate();
    days.push(
      byDate.get(d) || {
        date: d,
        mintedTotal: 0,
        burnedTotal: 0,
        netFlow: 0,
        mintedBySource: {},
        burnedBySource: {},
      },
    );
    cursor = cursor.plus({ days: 1 });
  }

  const totals = days.reduce(
    (acc, d) => {
      acc.mintedTotal += d.mintedTotal;
      acc.burnedTotal += d.burnedTotal;
      for (const [s, v] of Object.entries(d.mintedBySource)) {
        acc.mintedBySource[s] = (acc.mintedBySource[s] || 0) + v;
      }
      for (const [s, v] of Object.entries(d.burnedBySource)) {
        acc.burnedBySource[s] = (acc.burnedBySource[s] || 0) + v;
      }
      return acc;
    },
    { mintedTotal: 0, burnedTotal: 0, mintedBySource: {}, burnedBySource: {} },
  );
  totals.netFlow = totals.mintedTotal - totals.burnedTotal;

  return { days, totals };
}

// Top N holders（依 totalCoins），含占總量百分比
async function getTopHolders(client, guildId, limit = 10) {
  if (!client.userCoinsCollection) return { rows: [], totalWalletCoins: 0 };
  const [aggTotal, top] = await Promise.all([
    client.userCoinsCollection
      .aggregate([
        { $match: { guildId } },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$totalCoins", 0] } },
          },
        },
      ])
      .toArray(),
    client.userCoinsCollection
      .find({ guildId, totalCoins: { $gt: 0 } })
      .project({ userId: 1, totalCoins: 1, username: 1 })
      .sort({ totalCoins: -1 })
      .limit(limit)
      .toArray(),
  ]);
  const totalWalletCoins = aggTotal[0]?.total || 0;
  const rows = top.map((u) => ({
    userId: u.userId,
    username: u.username || null,
    totalCoins: u.totalCoins || 0,
    share: totalWalletCoins > 0 ? u.totalCoins / totalWalletCoins : 0,
  }));
  const top10Sum = rows.reduce((s, r) => s + r.totalCoins, 0);
  return {
    rows,
    totalWalletCoins,
    top10Share: totalWalletCoins > 0 ? top10Sum / totalWalletCoins : 0,
    top10Coins: top10Sum,
  };
}

// 當下流通量快照（與 /circulation 同口徑：錢包 + 啟用中存款）
async function getCirculationNow(client, guildId) {
  const [walletAgg, depositAgg] = await Promise.all([
    client.userCoinsCollection
      .aggregate([
        { $match: { guildId } },
        {
          $group: {
            _id: null,
            totalWalletCoins: { $sum: { $ifNull: ["$totalCoins", 0] } },
            activeUsers: {
              $sum: {
                $cond: [{ $gt: [{ $ifNull: ["$totalCoins", 0] }, 0] }, 1, 0],
              },
            },
            userCount: { $sum: 1 },
          },
        },
      ])
      .toArray(),
    client.coinDepositsCollection
      ? client.coinDepositsCollection
          .aggregate([
            { $match: { guildId, status: "active" } },
            {
              $group: {
                _id: null,
                totalDepositPrincipal: { $sum: { $ifNull: ["$principal", 0] } },
                activeDepositCount: { $sum: 1 },
              },
            },
          ])
          .toArray()
      : Promise.resolve([]),
  ]);
  const wallet = walletAgg[0] || {
    totalWalletCoins: 0,
    activeUsers: 0,
    userCount: 0,
  };
  const deposit = depositAgg[0] || {
    totalDepositPrincipal: 0,
    activeDepositCount: 0,
  };
  return {
    totalWalletCoins: wallet.totalWalletCoins,
    totalDepositPrincipal: deposit.totalDepositPrincipal,
    totalCirculation: wallet.totalWalletCoins + deposit.totalDepositPrincipal,
    activeUsers: wallet.activeUsers,
    userCount: wallet.userCount,
    activeDepositCount: deposit.activeDepositCount,
  };
}

// 近 N 天的 EconomySnapshots（流通量歷史）
async function getRecentSnapshots(client, guildId, days = 30) {
  if (!client.economySnapshotsCollection) return [];
  const fromIso = isoDaysAgo(days - 1);
  return client.economySnapshotsCollection
    .find({ guildId, date: { $gte: fromIso } })
    .sort({ date: 1 })
    .toArray();
}

// 將 source 分類為「純印 / 純銷 / 對沖」
function classifySource(source) {
  if (PURE_MINT_SOURCES.has(source)) return "mint";
  if (PURE_SINK_SOURCES.has(source)) return "sink";
  return "peer";
}

module.exports = {
  TZ,
  todayIso,
  isoDaysAgo,
  dateRangeIso,
  aggregateFlow,
  getTopHolders,
  getCirculationNow,
  getRecentSnapshots,
  classifySource,
  PURE_MINT_SOURCES,
  PURE_SINK_SOURCES,
};
