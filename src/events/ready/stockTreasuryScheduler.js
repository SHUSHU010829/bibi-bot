require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { stockSystem } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const treasuryService = require("../../features/stock/treasuryService");
const { rollingWindow } = require("../../features/stock/leaderboardService");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

function treasuryCfg() {
  return stockSystem?.treasury || {};
}

// 依權重不重複抽 k 位（權重 = 本週成交額）。
function weightedSampleDistinct(items, k, weightFn) {
  const pool = items
    .map((it) => ({ it, w: Math.max(0, weightFn(it)) }))
    .filter((x) => x.w > 0);
  const picked = [];
  for (let n = 0; n < k && pool.length; n += 1) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx += 1) {
      r -= pool[idx].w;
      if (r <= 0) break;
    }
    idx = Math.min(idx, pool.length - 1);
    picked.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return picked;
}

// 交易抽獎：本週成交額當抽獎券，加權抽 N 名平分彩池。無交易則不動用（rollover）。
async function runRaffle(client, guildId, pot) {
  if (pot <= 0) return { paid: 0, winners: [] };
  const window = rollingWindow(7);
  const rows = await client.stockTransactionsCollection
    .aggregate([
      {
        $match: {
          guildId,
          side: { $in: ["buy", "sell"] },
          timestamp: { $gte: window.start, $lt: window.end },
        },
      },
      {
        $group: {
          _id: "$userId",
          turnover: {
            $sum: {
              $add: [{ $ifNull: ["$totalCost", 0] }, { $ifNull: ["$proceeds", 0] }],
            },
          },
        },
      },
      { $match: { turnover: { $gt: 0 } } },
    ])
    .toArray()
    .catch(() => []);
  if (!rows.length) return { paid: 0, winners: [] };

  const winnersCount = Math.min(treasuryCfg().raffleWinners ?? 3, rows.length);
  const perWinner = Math.floor(pot / winnersCount);
  if (perWinner <= 0) return { paid: 0, winners: [] };

  const winners = weightedSampleDistinct(rows, winnersCount, (r) => r.turnover);
  const spent = await treasuryService.spendFromTreasury(client, guildId, perWinner * winners.length);
  if (spent <= 0) return { paid: 0, winners: [] };

  const out = [];
  for (const w of winners) {
    await grantCoins(client, {
      userId: w._id,
      guildId,
      amount: perWinner,
      source: "stock_raffle_prize",
      meta: { turnover: w.turnover },
    }).catch(() => {});
    out.push({ userId: w._id, prize: perWinner, turnover: w.turnover });
  }
  return { paid: perWinner * winners.length, winners: out };
}

// 散戶回饋：目前有持股且資產低於門檻者均分回饋池。無合格者則不動用（rollover）。
async function runRebate(client, guildId, pot) {
  if (pot <= 0) return { paid: 0, count: 0 };
  const holders = await client.userPortfolioCollection
    .distinct("userId", { guildId, shares: { $gt: 0 } })
    .catch(() => []);
  if (!holders.length) return { paid: 0, count: 0 };

  const eligibleBelow = treasuryCfg().rebate?.eligibleBelow ?? 50000;
  const coinsDocs = await client.userCoinsCollection
    .find({ guildId, userId: { $in: holders } })
    .project({ userId: 1, totalCoins: 1 })
    .toArray()
    .catch(() => []);
  const coinByUser = new Map(coinsDocs.map((c) => [c.userId, c.totalCoins || 0]));
  const eligible = holders.filter((u) => (coinByUser.get(u) || 0) < eligibleBelow);
  if (!eligible.length) return { paid: 0, count: 0 };

  const per = Math.floor(pot / eligible.length);
  if (per <= 0) return { paid: 0, count: 0 };

  const spent = await treasuryService.spendFromTreasury(client, guildId, per * eligible.length);
  if (spent <= 0) return { paid: 0, count: 0 };

  for (const userId of eligible) {
    await grantCoins(client, {
      userId,
      guildId,
      amount: per,
      source: "stock_rebate",
      meta: { rebate: per },
    }).catch(() => {});
  }
  return { paid: per * eligible.length, count: eligible.length, per };
}

async function announce(client, guildId, raffle, rebate, remaining) {
  const channelId = stockSystem?.reportChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const guild = client.guilds.cache.get(guildId);
  const nameOf = (id) => plainifyUserMentions(guild, `<@${id}>`);

  const raffleLine = raffle.winners.length
    ? raffle.winners
        .map((w) => `🎟️ ${nameOf(w.userId)} — **+${w.prize.toLocaleString()}**`)
        .join("\n")
    : "本週無人交易，彩金滾入下週 🔁";

  const rebateLine = rebate.count
    ? `🤝 ${rebate.count} 位小股民各得 **+${rebate.per.toLocaleString()}**（共 ${rebate.paid.toLocaleString()}）`
    : "本週無合格散戶，回饋滾入下週 🔁";

  const container = new ContainerBuilder()
    .setAccentColor(0x1abc9c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 🏛️ 證交所國庫｜本週回饋"),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🎟️ 交易抽獎**\n${raffleLine}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🤝 散戶回饋**\n${rebateLine}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**國庫餘額**\n${remaining.toLocaleString()} credits`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# 稅金取之於市場、用之於股民 ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
      ),
    );

  await channel
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

async function processGuild(client, guildId) {
  const tre = await treasuryService.getTreasury(client, guildId);
  const balance = tre.balance || 0;
  if (balance <= 0) return null;

  const raffleShare = treasuryCfg().raffleShare ?? 0.5;
  const rafflePot = Math.floor(balance * raffleShare);
  const rebatePot = balance - rafflePot;

  const raffle = await runRaffle(client, guildId, rafflePot);
  const rebate = await runRebate(client, guildId, rebatePot);

  if (raffle.paid === 0 && rebate.paid === 0) return null;

  const after = await treasuryService.getTreasury(client, guildId);
  await announce(client, guildId, raffle, rebate, after.balance || 0).catch((e) =>
    console.log(`[STOCK] treasury 回饋公告失敗 guild=${guildId}: ${e?.message || e}`.yellow),
  );
  console.log(
    `[STOCK] 國庫回饋 guild=${guildId} 抽獎 ${raffle.paid} / 回饋 ${rebate.paid}`.cyan,
  );
  return { guildId };
}

async function runTreasuryDraw(client) {
  if (!client.stockTreasuryCollection) return { processed: 0 };
  const guildIds = await client.stockTreasuryCollection
    .distinct("guildId", { balance: { $gt: 0 } })
    .catch(() => []);
  let processed = 0;
  for (const guildId of guildIds) {
    try {
      const r = await processGuild(client, guildId);
      if (r) processed += 1;
    } catch (e) {
      console.log(`[STOCK] 國庫回饋失敗 guild=${guildId}: ${e?.message || e}`.yellow);
    }
  }
  return { processed };
}

module.exports = async (client) => {
  if (!stockSystem?.enabled) return;
  const cfg = treasuryCfg();
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "stock.treasuryDraw",
    label: "股市國庫回饋結算",
    schedule: cfg.drawCronSchedule || "0 20 * * 0",
    timezone: stockSystem?.timezone || "Asia/Taipei",
    runner: () => runTreasuryDraw(client),
  });
};

module.exports.runTreasuryDraw = runTreasuryDraw;
