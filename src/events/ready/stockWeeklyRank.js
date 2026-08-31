require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { stockSystem } = require("../../config");
const leaderboardService = require("../../features/stock/leaderboardService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const stockKingService = require("../../features/stock/stockKingService");
const { hallButtonRow } = require("../../features/stock/stockKingView");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const MEDALS = ["🥇", "🥈", "🥉"];

function kingTitleId() {
  return stockSystem?.leaderboard?.titleId || "stock_king";
}

async function guildsWithTrades(client, window) {
  if (!client.stockTransactionsCollection) return [];
  return client.stockTransactionsCollection
    .distinct("guildId", {
      side: { $in: ["sell", "short_cover"] },
      timestamp: { $gte: window.start, $lt: window.end },
    })
    .catch(() => []);
}

// 卸下上一任操盤王（贏家除外）。
async function dethronePrevious(client, guildId, winnerId, winnerLabel) {
  const titleId = kingTitleId();
  if (!client.userLevelsCollection) return [];
  const prev = await client.userLevelsCollection
    .find({ guildId, gameTitles: titleId })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  const dethroned = [];
  for (const p of prev) {
    if (p.userId === winnerId) continue;
    await gameTitleService
      .revoke(client, { userId: p.userId, guildId, titleId, status: "revoked" })
      .catch(() => {});
    dethroned.push(p.userId);
    try {
      const user = await client.users.fetch(p.userId).catch(() => null);
      if (user) {
        await user
          .send(
            `📊 你的 **${gameTitleService.label(titleId)}** 稱號已移交給 ${winnerLabel}，下週再用操盤實力搶回來 📈`
          )
          .catch(() => {});
      }
    } catch (_) {
      /* noop */
    }
  }
  return dethroned;
}

async function announceKing(client, guildId, ranking, dethroned = [], reigns = 0) {
  const titleId = kingTitleId();
  const channelId = stockSystem?.reportChannelId || gameTitleService.announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch((e) => {
    console.log(`[STOCK] 週冠公告頻道 ${channelId} 取不到（頻道不存在或無權限）：${e?.message || e}`.yellow);
    return null;
  });
  if (!channel) return;
  if (!channel.isTextBased?.()) {
    console.log(`[STOCK] 週冠公告頻道 ${channelId} 不是文字頻道，公告未發出`.yellow);
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  const nameOf = (id) => plainifyUserMentions(guild, `<@${id}>`);
  const winnerId = ranking[0].userId;

  const top = ranking
    .slice(0, 3)
    .map((r, i) => {
      const sign = r.pnl >= 0 ? "+" : "";
      return `${MEDALS[i]} ${nameOf(r.userId)} — **${sign}${r.pnl.toLocaleString()}**（${r.trades} 筆）`;
    })
    .join("\n");

  const handoverNote = dethroned.length
    ? `\n王座由 ${dethroned.map((id) => nameOf(id)).join("、")} 移交 📊`
    : "";
  const reignNote = reigns > 1 ? `\n這是第 **${reigns}** 次封王 👑` : "";

  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📊 上週最強操盤手出爐！\n` +
          `恭喜 ${nameOf(winnerId)} 拿下上週已實現損益冠軍，獲得稱號 **${gameTitleService.label(titleId)}**！${reignNote}${handoverNote}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**上週損益前三名**\n${top || "—"}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 新的一週開始了，用 `/股市` 操盤角逐本週王座；歷屆名單看 `/股市 名人堂`",
      ),
    )
    .addActionRowComponents(hallButtonRow());

  await channel.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
  console.log(`[STOCK] 週冠公告已送出 guild=${guildId} channel=${channelId}`.cyan);
}

async function processGuild(client, guildId) {
  const window = leaderboardService.previousWeekWindow();
  const ranking = await leaderboardService.rankByWindow(client, guildId, {
    ...window,
    limit: stockSystem?.leaderboard?.topN || 10,
  });
  // 至少要有一位正報酬（冠軍虧錢就不頒王，免得「最強」是賠最少的）
  if (!ranking.length || ranking[0].pnl <= 0) return null;

  const winnerId = ranking[0].userId;

  // 同一週只結算一次：排程準時跑完後，補跑排程再進來就會停在這裡。
  const settled = await client.stockKingHistoryCollection
    ?.findOne({ guildId, weekStart: window.start })
    .catch(() => null);
  if (settled) return null;
  // 舊版沒有 StockKingHistory，補跑時只能靠稱號授予時間判斷這一輪是否已頒過
  if (
    await gameTitleService.grantedSince(client, {
      userId: winnerId,
      guildId,
      titleId: kingTitleId(),
      since: window.end.getTime(),
    })
  ) {
    // 稱號已經頒過（舊版排程跑的），只把紀錄補起來，不重複公告
    await stockKingService
      .recordAward(client, { guildId, window, ranking, source: "weekly_cron" })
      .catch(() => {});
    return null;
  }

  await gameTitleService
    .grant(client, { userId: winnerId, guildId, titleId: kingTitleId(), announce: false, source: "weekly_stock_king" })
    .catch(() => {});

  const guild = client.guilds.cache.get(guildId);
  const winnerLabel = plainifyUserMentions(guild, `<@${winnerId}>`);
  const dethroned = await dethronePrevious(client, guildId, winnerId, winnerLabel);

  await stockKingService
    .recordAward(client, { guildId, window, ranking, dethroned, source: "weekly_cron" })
    .catch((e) => console.log(`[STOCK] 週冠紀錄寫入失敗 guild=${guildId}: ${e?.message || e}`.yellow));
  // 紀錄寫入失敗時 count 會是 0，公告 / 私訊至少要算這次
  const reigns = Math.max(1, (await stockKingService.myReigns(client, guildId, winnerId)).reigns);

  if (stockSystem?.leaderboard?.announce !== false) {
    await announceKing(client, guildId, ranking, dethroned, reigns).catch((e) =>
      console.log(`[STOCK] 週冠公告失敗 guild=${guildId}: ${e?.message || e}`.yellow),
    );
  }

  try {
    const winner = await client.users.fetch(winnerId).catch(() => null);
    if (winner) {
      await winner
        .send(
          `📊 恭喜你成為 **${gameTitleService.label(kingTitleId())}**！上週已實現損益 +${ranking[0].pnl.toLocaleString()}，這是你第 ${reigns} 次封王，歷屆名單可用 /股市 名人堂 查看 📈`,
        )
        .catch(() => {});
    }
  } catch (_) {
    /* noop */
  }

  console.log(`[STOCK] 操盤週冠結算 guild=${guildId} winner=${winnerId}（+${ranking[0].pnl}）`.cyan);
  return { guildId, winnerId };
}

async function runWeeklyRank(client) {
  const window = leaderboardService.previousWeekWindow();
  const guildIds = await guildsWithTrades(client, window);
  if (!guildIds.length) {
    console.log(`[STOCK] 上週無成交紀錄，跳過操盤週冠結算`.gray);
    return { processed: 0 };
  }
  let processed = 0;
  for (const guildId of guildIds) {
    try {
      const r = await processGuild(client, guildId);
      if (r) processed += 1;
    } catch (e) {
      console.log(`[STOCK] 操盤週冠結算失敗 guild=${guildId}: ${e.message}`.yellow);
    }
  }
  return { processed };
}

module.exports = async (client) => {
  if (!stockSystem?.enabled) return;
  const cfg = stockSystem?.leaderboard || {};
  if (cfg.enabled === false) return;
  const timezone = cfg.timezone || stockSystem?.timezone || "Asia/Taipei";

  registerCron(client, {
    name: "stock.weeklyRank",
    label: "股市操盤週冠結算",
    schedule: cfg.cronSchedule || "1 0 * * 1",
    timezone,
    runner: () => runWeeklyRank(client),
  });

  // node-cron 不補跑錯過的排程：週一 00:01 剛好在重啟 / 部署 / 斷線中，那一週就
  // 永遠不會結算也不會公告。runWeeklyRank 已是冪等（看 StockKingHistory），所以
  // 開機後與每隔幾小時各補跑一次，錯過的那次會自己補回來。
  registerCron(client, {
    name: "stock.weeklyRankCatchup",
    label: "股市操盤週冠補跑",
    schedule: cfg.catchupCronSchedule || "7 */4 * * *",
    timezone,
    runner: () => runWeeklyRank(client),
  });

  setTimeout(() => {
    runWeeklyRank(client).catch((e) =>
      console.log(`[STOCK] 開機補跑週冠結算失敗：${e?.message || e}`.yellow),
    );
  }, cfg.catchupBootDelayMs || 2 * 60 * 1000).unref?.();
};

module.exports.runWeeklyRank = runWeeklyRank;
