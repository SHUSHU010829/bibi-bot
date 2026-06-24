require("colors");
const { DateTime } = require("luxon");
const { casino, mining, fishing, farming, stockSystem } = require("../../config");

const TZ = "Asia/Taipei";

// 各賭場遊戲的「設計 House Edge」。
// - 從 casino.json 讀到的 houseEdge 優先（hilo / crash / dragonGate）。
// - 其他依照遊戲設計檔的目標 RTP / 機率推算（roulette 純歐式單零、slot paytable 設計目標、
//   keno paytable + 抽 5/40 機率、blackjack 休閒玩法估計、sicbo 平均押注組合）。
// - 純 PvP / 池抽（poker / horseRacing / lottery）以 null 標記，
//   實際莊家邊際靠 CoinTransactions(bet - payout) 倒推。
const THEORETICAL_HOUSE_EDGE = {
  roulette: 1 / 37,
  slot: 0.16,
  sicbo: 0.10,
  blackjack: 0.02,
  hilo: casino?.hilo?.houseEdge ?? 0.05,
  keno: 0.27,
  crash: casino?.crash?.houseEdge ?? 0.02,
  dragonGate: casino?.dragonGate?.houseEdge ?? 0.05,
  poker: null,
  horseRacing: null,
  lottery: null,
};

// source 分類（與 grantCoins.js 同步維護）
const PURE_MINT_SOURCES = new Set([
  "mining_sell", "work", "dungeon", "welfare",
  "message", "voice", "reaction",
  "quest_daily", "quest_weekly", "quest_event",
  "stock_dividend", "invite_reward", "invite_welcome",
  "donation", "encounter",
  "farm_harvest", "farm_raid", "farm_sell", "farm_raid_trap",
  "boss_loot", "boss_killer", "boss_kill_bonus",
  "guild_create_refund", "guild_donate_refund", "guild_disband_payout",
  "deposit_interest",
  "fish_sell", "fish_loot",
  "mine_overflow", "gift_overflow", "stone_appraisal_overflow",
  "treasure_map", "levelup", "milestone", "survey",
]);
const PURE_SINK_SOURCES = new Set([
  "shop_buy", "wealth_tax", "stock_fee", "stone_appraisal",
  "farm_plant", "farm_expand", "barter_fee",
  "guild_create", "guild_donate",
  "guild_warehouse_fee", "guild_consign_buy",
  "invite_clawback",
  "transfer_fee", "deposit_penalty",
  "quest_reroll", "quest_skip",
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

// 當下流通量快照：錢包 + 啟用中存款
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

function dateRangeAsTs(fromIso, toIso) {
  const from = DateTime.fromISO(fromIso, { zone: TZ }).startOf("day").toJSDate();
  const to = DateTime.fromISO(toIso, { zone: TZ }).endOf("day").toJSDate();
  return { from, to };
}

// 各賭場遊戲的下注 / 派彩聚合，回傳每款遊戲的 wagered / payout / netHouse / empiricalEdge。
// 同時附 theoreticalEdge（設計值）給比對用。
async function aggregateCasinoEdge(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) {
    return { games: [], totals: { wagered: 0, payout: 0, netHouse: 0, betCount: 0 } };
  }
  const match = {
    guildId,
    source: { $in: ["bet", "payout"] },
    date: { $gte: fromIso, $lte: toIso },
  };
  const rows = await client.coinTransactionsCollection
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: { game: "$meta.game", source: "$source" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
          users: { $addToSet: "$userId" },
        },
      },
    ])
    .toArray();

  const perGame = {};
  for (const r of rows) {
    const g = r._id.game || "unknown";
    if (!perGame[g]) {
      perGame[g] = {
        game: g,
        wagered: 0,
        payout: 0,
        betCount: 0,
        payoutCount: 0,
        bettors: new Set(),
        winners: new Set(),
      };
    }
    if (r._id.source === "bet") {
      perGame[g].wagered += Math.abs(r.total);
      perGame[g].betCount += r.count;
      for (const u of r.users) perGame[g].bettors.add(u);
    } else {
      perGame[g].payout += r.total;
      perGame[g].payoutCount += r.count;
      for (const u of r.users) perGame[g].winners.add(u);
    }
  }

  const games = Object.values(perGame).map((g) => {
    const netHouse = g.wagered - g.payout;
    const rtp = g.wagered > 0 ? g.payout / g.wagered : 0;
    const empiricalEdge = g.wagered > 0 ? 1 - rtp : null;
    return {
      game: g.game,
      wagered: g.wagered,
      payout: g.payout,
      betCount: g.betCount,
      payoutCount: g.payoutCount,
      uniqueBettors: g.bettors.size,
      uniqueWinners: g.winners.size,
      netHouse,
      rtp,
      empiricalEdge,
      theoreticalEdge: THEORETICAL_HOUSE_EDGE[g.game] ?? null,
    };
  });
  games.sort((a, b) => b.wagered - a.wagered);

  const totals = games.reduce(
    (acc, g) => {
      acc.wagered += g.wagered;
      acc.payout += g.payout;
      acc.netHouse += g.netHouse;
      acc.betCount += g.betCount;
      return acc;
    },
    { wagered: 0, payout: 0, netHouse: 0, betCount: 0 },
  );
  return { games, totals };
}

// 礦石每日流通量：依 MineLogs 聚合 qty / 場次 / 不重複礦工，附當日市價估值
async function aggregateOreCirculation(client, guildId, fromIso, toIso) {
  if (!client.mineLogsCollection) {
    return { ores: [], totalQty: 0, totalSessions: 0, days: 1 };
  }
  const { from, to } = dateRangeAsTs(fromIso, toIso);
  const rows = await client.mineLogsCollection
    .aggregate([
      { $match: { guild_id: guildId, ts: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: "$ore",
          qty: { $sum: "$qty" },
          sessions: { $sum: 1 },
          miners: { $addToSet: "$user_id" },
        },
      },
    ])
    .toArray();

  const days = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / 86400000),
  );
  const ores = rows.map((r) => {
    const def = mining?.ores?.[r._id] || {};
    return {
      ore: r._id,
      name: def.name || r._id,
      emoji: def.emoji || "",
      basePrice: def.price || 0,
      qty: r.qty || 0,
      sessions: r.sessions || 0,
      uniqueMiners: r.miners?.length || 0,
      dailyAvgQty: (r.qty || 0) / days,
      estValue: (r.qty || 0) * (def.price || 0),
    };
  });
  ores.sort((a, b) => b.qty - a.qty);

  const totalQty = ores.reduce((s, o) => s + o.qty, 0);
  const totalSessions = ores.reduce((s, o) => s + o.sessions, 0);
  const totalValue = ores.reduce((s, o) => s + o.estValue, 0);
  const minersSet = new Set();
  for (const r of rows) for (const u of r.miners || []) minersSet.add(u);
  return {
    ores,
    totalQty,
    totalSessions,
    totalValue,
    uniqueMiners: minersSet.size,
    days,
  };
}

// 賭石鑑定流通量：以 stone_appraisal 為主，meta.count / meta.winnings 為據聚合每礦勝率與 RTP。
// 同時併入 stone_appraisal_overflow（背包滿溢時的折金幣補償）。
async function aggregateStoneAppraisal(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) {
    return {
      sessions: 0,
      stones: 0,
      fee: 0,
      overflowCoins: 0,
      uniqueAppraisers: 0,
      brokenCount: 0,
      brokenRate: 0,
      gainedValue: 0,
      rtp: 0,
      perOre: [],
    };
  }
  const docs = await client.coinTransactionsCollection
    .find({
      guildId,
      source: { $in: ["stone_appraisal", "stone_appraisal_overflow"] },
      date: { $gte: fromIso, $lte: toIso },
    })
    .project({ source: 1, amount: 1, userId: 1, meta: 1 })
    .toArray();

  let sessions = 0;
  let stones = 0;
  let fee = 0;
  let overflowCoins = 0;
  const winningsByOre = {};
  const successByOre = {};
  const appraisers = new Set();

  for (const d of docs) {
    if (d.source === "stone_appraisal") {
      sessions += 1;
      stones += Math.max(0, Math.floor(d.meta?.count || 0));
      fee += Math.max(0, -Number(d.amount || 0));
      appraisers.add(d.userId);
      const w = d.meta?.winnings || {};
      for (const [ore, qty] of Object.entries(w)) {
        const q = Math.max(0, Math.floor(qty || 0));
        if (q <= 0) continue;
        winningsByOre[ore] = (winningsByOre[ore] || 0) + q;
        successByOre[ore] = (successByOre[ore] || 0) + 1;
      }
    } else if (d.source === "stone_appraisal_overflow") {
      overflowCoins += Math.max(0, Number(d.amount || 0));
    }
  }

  const totalGainedQty = Object.values(winningsByOre).reduce((s, n) => s + n, 0);
  const brokenCount = Math.max(0, stones - totalGainedQty);
  const brokenRate = stones > 0 ? brokenCount / stones : 0;

  const perOre = Object.entries(winningsByOre)
    .map(([ore, qty]) => {
      const def = mining?.ores?.[ore] || {};
      const value = qty * (def.price || 0);
      return {
        ore,
        name: def.name || ore,
        emoji: def.emoji || "",
        basePrice: def.price || 0,
        qty,
        sessions: successByOre[ore] || 0,
        hitRate: stones > 0 ? (successByOre[ore] || 0) / stones : 0,
        value,
      };
    })
    .sort((a, b) => b.value - a.value);

  const gainedValue = perOre.reduce((s, o) => s + o.value, 0);
  const rtp = fee > 0 ? gainedValue / fee : 0;

  return {
    sessions,
    stones,
    fee,
    overflowCoins,
    uniqueAppraisers: appraisers.size,
    brokenCount,
    brokenRate,
    gainedValue,
    rtp,
    perOre,
  };
}

// 漁獲每日流通量：依 FishLogs 聚合，含釣點分布
async function aggregateFishCirculation(client, guildId, fromIso, toIso) {
  if (!client.fishLogsCollection) {
    return { fish: [], locations: [], totalCatches: 0, uniqueAnglers: 0, days: 1 };
  }
  const { from, to } = dateRangeAsTs(fromIso, toIso);
  const [byFish, byLoc] = await Promise.all([
    client.fishLogsCollection
      .aggregate([
        { $match: { guild_id: guildId, ts: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: "$fish",
            count: { $sum: 1 },
            anglers: { $addToSet: "$user_id" },
          },
        },
      ])
      .toArray(),
    client.fishLogsCollection
      .aggregate([
        { $match: { guild_id: guildId, ts: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: "$location",
            count: { $sum: 1 },
          },
        },
      ])
      .toArray(),
  ]);

  const days = Math.max(
    1,
    Math.round((to.getTime() - from.getTime()) / 86400000),
  );
  const fish = byFish.map((r) => {
    const def = fishing?.fish?.[r._id] || {};
    return {
      fish: r._id,
      name: def.name || r._id,
      emoji: def.emoji || "",
      basePrice: def.price || 0,
      count: r.count || 0,
      uniqueAnglers: r.anglers?.length || 0,
      dailyAvg: (r.count || 0) / days,
      estValue: (r.count || 0) * (def.price || 0),
    };
  });
  fish.sort((a, b) => b.count - a.count);

  const locations = byLoc.map((r) => {
    const def = fishing?.locations?.[r._id] || {};
    return {
      location: r._id,
      name: def.name || r._id,
      emoji: def.emoji || "",
      count: r.count || 0,
    };
  });
  locations.sort((a, b) => b.count - a.count);

  const anglersSet = new Set();
  for (const r of byFish) for (const u of r.anglers || []) anglersSet.add(u);
  const totalCatches = fish.reduce((s, f) => s + f.count, 0);
  const totalValue = fish.reduce((s, f) => s + f.estValue, 0);
  return {
    fish,
    locations,
    totalCatches,
    totalValue,
    uniqueAnglers: anglersSet.size,
    days,
  };
}

// 作物每日流通量：依 CoinTransactions 聚合 farm_plant / farm_harvest / farm_sell / farm_raid
async function aggregateCropFlow(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) {
    return { crops: [], totals: {}, days: 1 };
  }
  const rows = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          source: { $in: ["farm_plant", "farm_harvest", "farm_sell", "farm_raid", "farm_raid_trap", "farm_expand"] },
          date: { $gte: fromIso, $lte: toIso },
        },
      },
      {
        $group: {
          _id: {
            source: "$source",
            crop: { $ifNull: ["$meta.crop", "$meta.veggie"] },
          },
          amount: { $sum: "$amount" },
          count: { $sum: 1 },
          users: { $addToSet: "$userId" },
        },
      },
    ])
    .toArray();

  const cropMap = {};
  let plantCost = 0;
  let harvestPayout = 0;
  let sellValue = 0;
  let raidLoss = 0;
  let raidPayout = 0;
  let expandCost = 0;
  const farmerSet = new Set();

  for (const r of rows) {
    const { source, crop } = r._id;
    for (const u of r.users || []) farmerSet.add(u);
    if (source === "farm_expand") {
      expandCost += Math.abs(r.amount);
      continue;
    }
    if (source === "farm_raid_trap") {
      raidPayout += Math.max(0, r.amount);
      continue;
    }
    if (source === "farm_raid") {
      raidLoss += Math.abs(Math.min(0, r.amount));
      raidPayout += Math.max(0, r.amount);
      continue;
    }
    const key = crop || "unknown";
    if (!cropMap[key]) {
      cropMap[key] = {
        crop: key,
        plantCount: 0,
        plantCost: 0,
        harvestCount: 0,
        harvestPayout: 0,
        sellCount: 0,
        sellValue: 0,
      };
    }
    if (source === "farm_plant") {
      cropMap[key].plantCount += r.count;
      cropMap[key].plantCost += Math.abs(r.amount);
      plantCost += Math.abs(r.amount);
    } else if (source === "farm_harvest") {
      cropMap[key].harvestCount += r.count;
      cropMap[key].harvestPayout += r.amount;
      harvestPayout += r.amount;
    } else if (source === "farm_sell") {
      cropMap[key].sellCount += r.count;
      cropMap[key].sellValue += r.amount;
      sellValue += r.amount;
    }
  }

  const crops = Object.values(cropMap).map((c) => {
    const def = farming?.crops?.[c.crop] || {};
    return {
      ...c,
      name: def.name || c.crop,
      emoji: def.emoji || "🌱",
      successRate: c.plantCount > 0 ? c.harvestCount / c.plantCount : null,
    };
  });
  crops.sort((a, b) => b.harvestPayout + b.sellValue - (a.harvestPayout + a.sellValue));

  const days = Math.max(
    1,
    Math.round(
      (DateTime.fromISO(toIso, { zone: TZ }).startOf("day").toMillis() -
        DateTime.fromISO(fromIso, { zone: TZ }).startOf("day").toMillis()) /
        86400000,
    ) + 1,
  );
  return {
    crops,
    totals: {
      plantCost,
      harvestPayout,
      sellValue,
      raidLoss,
      raidPayout,
      expandCost,
      uniqueFarmers: farmerSet.size,
      netFarmIncome: harvestPayout + sellValue - plantCost - expandCost,
    },
    days,
  };
}

// 股票市場：即時持股分布（UserPortfolio）+ 即時行情（StockMarket）+ 期間交易量（StockTransactions）。
// 回傳每檔股票的持股人 / 持股市值 / 未實現損益，與期間買賣量、手續費、已實現損益、股息。
async function aggregateStockMarket(client, guildId, fromIso, toIso) {
  const empty = { stocks: [], totals: null, days: 1 };
  if (!client.stockMarketCollection || !client.stockTransactionsCollection) {
    return empty;
  }
  const { from, to } = dateRangeAsTs(fromIso, toIso);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
  const poolBySymbol = {};
  for (const s of stockSystem?.pool || []) poolBySymbol[s.symbol] = s;

  const [markets, holdingsBySymbol, uniqueHolders, txRows] = await Promise.all([
    client.stockMarketCollection.find({ guildId }).toArray(),
    client.userPortfolioCollection
      ? client.userPortfolioCollection
          .aggregate([
            { $match: { guildId, shares: { $gt: 0 } } },
            {
              $group: {
                _id: "$symbol",
                holders: { $sum: 1 },
                heldShares: { $sum: "$shares" },
                investedCost: { $sum: { $multiply: ["$shares", { $ifNull: ["$avgCost", 0] }] } },
              },
            },
          ])
          .toArray()
      : Promise.resolve([]),
    client.userPortfolioCollection
      ? client.userPortfolioCollection
          .aggregate([
            { $match: { guildId, shares: { $gt: 0 } } },
            { $group: { _id: "$userId" } },
            { $count: "n" },
          ])
          .toArray()
      : Promise.resolve([]),
    client.stockTransactionsCollection
      .aggregate([
        { $match: { guildId, timestamp: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { symbol: "$symbol", side: "$side" },
            shares: { $sum: { $ifNull: ["$shares", 0] } },
            proceeds: { $sum: { $ifNull: ["$proceeds", 0] } },
            totalCost: { $sum: { $ifNull: ["$totalCost", 0] } },
            payout: { $sum: { $ifNull: ["$payout", 0] } },
            fee: { $sum: { $ifNull: ["$fee", 0] } },
            pnl: { $sum: { $ifNull: ["$pnl", 0] } },
            count: { $sum: 1 },
            users: { $addToSet: "$userId" },
          },
        },
      ])
      .toArray(),
  ]);

  const holdMap = {};
  for (const h of holdingsBySymbol) holdMap[h._id] = h;

  const txMap = {};
  for (const r of txRows) {
    const sym = r._id.symbol;
    if (!txMap[sym]) txMap[sym] = { traders: new Set(), txCount: 0 };
    const t = txMap[sym];
    t.txCount += r.count;
    for (const u of r.users || []) t.traders.add(u);
    if (r._id.side === "buy") {
      t.buyShares = r.shares;
      t.buyValue = r.totalCost;
      t.buyFee = r.fee;
    } else if (r._id.side === "sell") {
      t.sellShares = r.shares;
      t.sellValue = r.proceeds;
      t.sellFee = r.fee;
      t.realizedPnl = r.pnl;
    } else if (r._id.side === "dividend") {
      t.dividendPaid = r.payout;
      t.dividendCount = r.count;
    }
  }

  const symbols = new Set([
    ...markets.map((m) => m.symbol),
    ...Object.keys(holdMap),
    ...Object.keys(txMap),
  ]);

  const stocks = [...symbols].map((sym) => {
    const m = markets.find((x) => x.symbol === sym) || {};
    const def = poolBySymbol[sym] || {};
    const hold = holdMap[sym] || {};
    const tx = txMap[sym] || {};
    const currentPrice = m.currentPrice ?? def.initialPrice ?? 0;
    const heldShares = hold.heldShares || 0;
    const investedCost = hold.investedCost || 0;
    const heldValue = heldShares * currentPrice;
    return {
      symbol: sym,
      name: m.name || def.name || sym,
      type: def.type || null,
      enabled: m.enabled !== false,
      currentPrice,
      holders: hold.holders || 0,
      heldShares,
      heldValue,
      investedCost,
      unrealizedPnl: heldValue - investedCost,
      buyShares: tx.buyShares || 0,
      buyValue: tx.buyValue || 0,
      sellShares: tx.sellShares || 0,
      sellValue: tx.sellValue || 0,
      feeTotal: (tx.buyFee || 0) + (tx.sellFee || 0),
      realizedPnl: tx.realizedPnl || 0,
      dividendPaid: tx.dividendPaid || 0,
      dividendCount: tx.dividendCount || 0,
      uniqueTraders: tx.traders ? tx.traders.size : 0,
      txCount: tx.txCount || 0,
    };
  });
  stocks.sort((a, b) => b.heldValue - a.heldValue);

  const totals = stocks.reduce(
    (acc, s) => {
      acc.heldShares += s.heldShares;
      acc.heldValue += s.heldValue;
      acc.investedCost += s.investedCost;
      acc.buyShares += s.buyShares;
      acc.buyValue += s.buyValue;
      acc.sellShares += s.sellShares;
      acc.sellValue += s.sellValue;
      acc.feeTotal += s.feeTotal;
      acc.realizedPnl += s.realizedPnl;
      acc.dividendPaid += s.dividendPaid;
      acc.txCount += s.txCount;
      return acc;
    },
    {
      heldShares: 0, heldValue: 0, investedCost: 0,
      buyShares: 0, buyValue: 0, sellShares: 0, sellValue: 0,
      feeTotal: 0, realizedPnl: 0, dividendPaid: 0, txCount: 0,
    },
  );
  totals.unrealizedPnl = totals.heldValue - totals.investedCost;
  totals.totalHolders = uniqueHolders[0]?.n || 0;
  totals.symbolCount = markets.length;
  totals.enabledCount = markets.filter((m) => m.enabled !== false).length;
  totals.marketSentiment = markets[0]?.marketSentiment || stockSystem?.defaultMarketSentiment || "sideways";

  return { stocks, totals, days };
}

// 市場活動量分組（source → 活動類別）。
// 同時作為「已知金流 source」的權威清單來源，供 getUnclassifiedFlow 偵測漏接的新 source。
const MARKET_GROUPS = {
  shop: ["shop_buy"],
  stock: ["stock_buy", "stock_sell", "stock_fee", "stock_dividend"],
  auction: ["auction_bid", "auction_payout", "auction_refund"],
  market: ["market_buy", "market_escrow", "market_bid", "market_payout", "market_refund"],
  barter: ["barter_fee"],
  transfer: ["transfer_in", "transfer_out"],
  transferFee: ["transfer_fee"],
  deposit: ["deposit_lock", "deposit_release"],
  depositInterest: ["deposit_interest"],
  depositPenalty: ["deposit_penalty"],
  welfare: ["welfare"],
  wealthTax: ["wealth_tax"],
  duel: ["duel_stake", "duel_payout", "duel_refund"],
  work: ["work"],
  mining: ["mining_sell", "stone_appraisal", "stone_appraisal_overflow", "mine_overflow", "gift_overflow"],
  fishing: ["fish_sell", "fish_loot"],
  farming: ["farm_plant", "farm_harvest", "farm_sell", "farm_raid", "farm_raid_trap", "farm_expand"],
  treasure: ["treasure_map"],
  leveling: ["levelup", "milestone"],
  donation: ["donation"],
  survey: ["survey"],
  chat: ["message", "voice", "reaction"],
  quest: ["quest_daily", "quest_weekly", "quest_event"],
  questManage: ["quest_reroll", "quest_skip"],
  dungeon: ["dungeon"],
  boss: ["boss_loot", "boss_killer", "boss_kill_bonus"],
  invite: ["invite_reward", "invite_welcome", "invite_clawback"],
  guild: ["guild_create", "guild_donate", "guild_create_refund", "guild_donate_refund", "guild_disband_payout", "guild_warehouse_fee", "guild_consign_buy"],
  encounter: ["encounter"],
  event: ["event_host_lock", "event_prize", "event_refund"],
};

// 所有「儀表板已知」的金流 source（市場分組 + 賭場下注 / 派彩）。
// 新增 source 卻忘了納入分組時，getUnclassifiedFlow 會把它撈出來顯示，避免資料靜默消失。
const KNOWN_SOURCES = new Set([
  ...Object.values(MARKET_GROUPS).flat(),
  "bet",
  "payout",
  "admin",
]);

// 比對期間 flow 的 mintedBySource / burnedBySource，找出不在 KNOWN_SOURCES 的 source。
// 回傳依淨額絕對值排序的清單，作為「新 source 漏接」的安全網。
function getUnclassifiedFlow(totals) {
  if (!totals) return [];
  const seen = new Set([
    ...Object.keys(totals.mintedBySource || {}),
    ...Object.keys(totals.burnedBySource || {}),
  ]);
  const out = [];
  for (const s of seen) {
    if (KNOWN_SOURCES.has(s)) continue;
    const minted = totals.mintedBySource?.[s] || 0;
    const burned = totals.burnedBySource?.[s] || 0;
    out.push({ source: s, minted, burned, net: minted - burned });
  }
  out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  return out;
}

// 市場活動量：商店、股票、市集 / 拍賣 / 交易所、玩家轉帳
async function aggregateMarketActivity(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) return {};
  const groups = MARKET_GROUPS;
  const allSources = Object.values(groups).flat();

  const rows = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          source: { $in: allSources },
          date: { $gte: fromIso, $lte: toIso },
        },
      },
      {
        $group: {
          _id: "$source",
          positive: { $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] } },
          negative: { $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] } },
          count: { $sum: 1 },
          users: { $addToSet: "$userId" },
        },
      },
    ])
    .toArray();

  const bySource = {};
  for (const r of rows) {
    bySource[r._id] = {
      inflow: r.positive,
      outflow: -r.negative,
      count: r.count,
      uniqueUsers: r.users?.length || 0,
    };
  }
  const result = {};
  for (const [name, sources] of Object.entries(groups)) {
    let inflow = 0;
    let outflow = 0;
    let count = 0;
    for (const s of sources) {
      const v = bySource[s];
      if (!v) continue;
      inflow += v.inflow;
      outflow += v.outflow;
      count += v.count;
    }
    result[name] = { inflow, outflow, count, volume: inflow + outflow };
  }
  return result;
}

// 進行中的定存統計：依存期分組，含未到期利息
async function aggregateDeposits(client, guildId) {
  if (!client.coinDepositsCollection) {
    return { active: 0, principal: 0, avgPrincipal: 0, totalInterest: 0, plans: [] };
  }
  const byDays = await client.coinDepositsCollection
    .aggregate([
      { $match: { guildId, status: "active" } },
      {
        $group: {
          _id: "$days",
          count: { $sum: 1 },
          principal: { $sum: { $ifNull: ["$principal", 0] } },
          interest: { $sum: { $ifNull: ["$interest", 0] } },
          users: { $addToSet: "$userId" },
        },
      },
    ])
    .toArray();
  const plans = byDays.map((r) => ({
    days: r._id ?? null,
    count: r.count,
    principal: r.principal,
    interest: r.interest,
    uniqueUsers: r.users?.length || 0,
  }));
  plans.sort((a, b) => (a.days || 0) - (b.days || 0));
  const principal = plans.reduce((s, p) => s + p.principal, 0);
  const active = plans.reduce((s, p) => s + p.count, 0);
  const totalInterest = plans.reduce((s, p) => s + p.interest, 0);
  return {
    active,
    principal,
    totalInterest,
    avgPrincipal: active > 0 ? principal / active : 0,
    plans,
  };
}

// 財富分布指標：Gini、Top% 持有占比、活躍持幣人數
async function aggregateWealthMetrics(client, guildId) {
  if (!client.userCoinsCollection) return null;
  const docs = await client.userCoinsCollection
    .find({ guildId, totalCoins: { $gt: 0 } })
    .project({ totalCoins: 1 })
    .toArray();
  const wallets = docs.map((d) => d.totalCoins || 0).sort((a, b) => a - b);
  const n = wallets.length;
  if (n === 0) return { gini: 0, top1Share: 0, top10Share: 0, top50Share: 0, medianWallet: 0, meanWallet: 0, holders: 0 };

  const total = wallets.reduce((s, v) => s + v, 0);
  // Gini coefficient: G = (2 * sum(i*x_i) - (n+1) * sum(x_i)) / (n * sum(x_i))，wallets 已升冪。
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * wallets[i];
  const gini = total > 0 ? (2 * weighted) / (n * total) - (n + 1) / n : 0;

  const top = wallets.slice().reverse();
  const sumTop = (k) => top.slice(0, k).reduce((s, v) => s + v, 0);
  const top1Count = Math.max(1, Math.ceil(n * 0.01));
  const top10Count = Math.max(1, Math.ceil(n * 0.10));
  const top50Count = Math.max(1, Math.ceil(n * 0.50));
  const median = n % 2 ? wallets[(n - 1) >> 1] : (wallets[n / 2 - 1] + wallets[n / 2]) / 2;

  return {
    gini,
    top1Share: total > 0 ? sumTop(top1Count) / total : 0,
    top10Share: total > 0 ? sumTop(top10Count) / total : 0,
    top50Share: total > 0 ? sumTop(top50Count) / total : 0,
    medianWallet: median,
    meanWallet: total / n,
    holders: n,
    richestWallet: top[0] || 0,
  };
}

// 在期間內有過任一筆 CoinTransactions 的玩家數（活躍經濟人口）
async function countActivePlayers(client, guildId, fromIso, toIso) {
  if (!client.coinTransactionsCollection) return 0;
  const r = await client.coinTransactionsCollection
    .aggregate([
      { $match: { guildId, date: { $gte: fromIso, $lte: toIso } } },
      { $group: { _id: "$userId" } },
      { $count: "n" },
    ])
    .toArray();
  return r[0]?.n || 0;
}

// 取得當日 / 前日礦石、漁獲市價（從 OreMarketPrices 取 freeze 過的，未 freeze 用 config 基準）
async function getMarketPricesForDate(client, dateIso) {
  if (!client.oreMarketPricesCollection) return { ore: {}, fish: {} };
  const dateStr = dateIso.replace(/-/g, "");
  const doc = await client.oreMarketPricesCollection.findOne({ date: dateStr }).catch(() => null);
  return {
    ore: doc?.prices || {},
    fish: doc?.fishPrices || {},
  };
}

module.exports = {
  TZ,
  THEORETICAL_HOUSE_EDGE,
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
  MARKET_GROUPS,
  KNOWN_SOURCES,
  getUnclassifiedFlow,
  aggregateCasinoEdge,
  aggregateOreCirculation,
  aggregateStoneAppraisal,
  aggregateFishCirculation,
  aggregateCropFlow,
  aggregateStockMarket,
  aggregateMarketActivity,
  aggregateDeposits,
  aggregateWealthMetrics,
  countActivePlayers,
  getMarketPricesForDate,
};
