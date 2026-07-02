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

async function announceKing(client, guildId, ranking, dethroned = []) {
  const titleId = kingTitleId();
  const channelId = stockSystem?.reportChannelId || gameTitleService.announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

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

  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 📊 上週最強操盤手出爐！\n` +
          `恭喜 ${nameOf(winnerId)} 拿下上週已實現損益冠軍，獲得稱號 **${gameTitleService.label(titleId)}**！${handoverNote}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**上週損益前三名**\n${top || "—"}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 新的一週開始了，用 `/股市` 操盤角逐本週王座！",
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
  const window = leaderboardService.previousWeekWindow();
  const ranking = await leaderboardService.rankByWindow(client, guildId, {
    ...window,
    limit: stockSystem?.leaderboard?.topN || 10,
  });
  // 至少要有一位正報酬（冠軍虧錢就不頒王，免得「最強」是賠最少的）
  if (!ranking.length || ranking[0].pnl <= 0) return null;

  const winnerId = ranking[0].userId;
  await gameTitleService
    .grant(client, { userId: winnerId, guildId, titleId: kingTitleId(), announce: false, source: "weekly_stock_king" })
    .catch(() => {});

  const guild = client.guilds.cache.get(guildId);
  const winnerLabel = plainifyUserMentions(guild, `<@${winnerId}>`);
  const dethroned = await dethronePrevious(client, guildId, winnerId, winnerLabel);

  if (stockSystem?.leaderboard?.announce !== false) {
    await announceKing(client, guildId, ranking, dethroned).catch((e) =>
      console.log(`[STOCK] 週冠公告失敗 guild=${guildId}: ${e?.message || e}`.yellow),
    );
  }

  try {
    const winner = await client.users.fetch(winnerId).catch(() => null);
    if (winner) {
      await winner
        .send(
          `📊 恭喜你成為 **${gameTitleService.label(kingTitleId())}**！上週已實現損益 +${ranking[0].pnl.toLocaleString()}，繼續用 /股市 守住王座 📈`,
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

  registerCron(client, {
    name: "stock.weeklyRank",
    label: "股市操盤週冠結算",
    schedule: cfg.cronSchedule || "1 0 * * 1",
    timezone: cfg.timezone || stockSystem?.timezone || "Asia/Taipei",
    runner: () => runWeeklyRank(client),
  });
};

module.exports.runWeeklyRank = runWeeklyRank;
