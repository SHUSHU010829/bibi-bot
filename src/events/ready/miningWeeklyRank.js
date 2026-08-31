require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const rankService = require("../../features/mining/rankService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const KING_TITLE = "mine_king";
const MEDALS = ["🥇", "🥈", "🥉"];

async function guildsWithLogs(client, window) {
  if (!client.mineLogsCollection) return [];
  return client.mineLogsCollection
    .distinct("guild_id", { ts: { $gte: window.start, $lt: window.end } })
    .catch(() => []);
}

// 卸下上一任礦坑之王（贏家除外）。解鎖清單存在 UserLevels.gameTitles。
// 回傳實際被卸任的舊王 userId 陣列（供公告 / 已在內部發 DM）。
async function dethronePrevious(client, guildId, winnerId, winnerLabel) {
  if (!client.userLevelsCollection) return [];
  const prev = await client.userLevelsCollection
    .find({ guildId, gameTitles: KING_TITLE })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  const dethroned = [];
  for (const p of prev) {
    if (p.userId === winnerId) continue;
    await gameTitleService
      .revoke(client, { userId: p.userId, guildId, titleId: KING_TITLE, status: "revoked" })
      .catch(() => {});
    dethroned.push(p.userId);
    // 前任王 DM 通知
    try {
      const user = await client.users.fetch(p.userId).catch(() => null);
      if (user) {
        await user
          .send(
            `👑 你的 **${gameTitleService.label(KING_TITLE)}** 稱號已移交給 ${winnerLabel}，期待你下週奪回王座 ⛏️`
          )
          .catch(() => {});
      }
    } catch (_) {
      /* noop */
    }
  }
  return dethroned;
}

async function announceKing(client, guildId, winnerId, ranking, championCount, dethroned = []) {
  const channelId = gameTitleService.announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch((e) => {
    console.log(`[MINING] 週冠公告頻道 ${channelId} 取不到（頻道不存在或無權限）：${e?.message || e}`.yellow);
    return null;
  });
  if (!channel) return;
  if (!channel.isTextBased?.()) {
    console.log(`[MINING] 週冠公告頻道 ${channelId} 不是文字頻道，公告未發出`.yellow);
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  const nameOf = (id) => plainifyUserMentions(guild, `<@${id}>`);

  const top = ranking
    .slice(0, 3)
    .map((r, i) => `${MEDALS[i]} ${nameOf(r.userId)} — **${r.total.toLocaleString()}** 顆`)
    .join("\n");

  const handoverNote = dethroned.length
    ? `\n王座由 ${dethroned.map((id) => nameOf(id)).join("、")} 移交 👑`
    : "";

  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 👑 上週礦坑之王出爐！\n` +
          `恭喜 ${nameOf(winnerId)} 拿下上週挖礦榜冠軍，獲得稱號 **${gameTitleService.label(KING_TITLE)}**！\n` +
          `這是他第 **${championCount}** 次稱王 👑${handoverNote}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**上週前三名**\n${top || "—"}`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 新的一週開始了，用 /挖礦 角逐本週王座！",
      ),
    );

  await channel.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  });
}

async function processGuild(client, guildId) {
  const window = rankService.previousWeekWindow();
  const ranking = await rankService.rankByWindow(client, guildId, { ...window, limit: 10 });
  if (!ranking.length) return null;

  const winnerId = ranking[0].userId;

  // 同一週只結算一次：補跑排程再進來時，靠稱號授予時間判斷這一輪是否已頒過，
  // 否則 weekly_champion_count 會被重複累加、公告也會重發。
  if (
    await gameTitleService.grantedSince(client, {
      userId: winnerId,
      guildId,
      titleId: KING_TITLE,
      since: window.end.getTime(),
    })
  ) {
    return null;
  }

  // 先頒給新王（idempotent，自行做專屬公告所以關掉預設公告），再卸下舊王
  await gameTitleService
    .grant(client, {
      userId: winnerId,
      guildId,
      titleId: KING_TITLE,
      announce: false,
      source: "weekly_king",
    })
    .catch(() => {});

  const updated = await client.miningProfilesCollection
    ?.findOneAndUpdate(
      { userId: winnerId, guildId },
      { $inc: { weekly_champion_count: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    )
    .catch(() => null);
  const championCount = (updated?.value || updated)?.weekly_champion_count || 1;

  const guild = client.guilds.cache.get(guildId);
  const winnerLabel = plainifyUserMentions(guild, `<@${winnerId}>`);
  const dethroned = await dethronePrevious(client, guildId, winnerId, winnerLabel);
  await announceKing(client, guildId, winnerId, ranking, championCount, dethroned).catch((e) =>
    console.log(`[MINING] 週冠公告失敗 guild=${guildId}: ${e?.message || e}`.yellow),
  );

  // 新王 DM 通知
  try {
    const winner = await client.users.fetch(winnerId).catch(() => null);
    if (winner) {
      await winner
        .send(
          `👑 恭喜你成為 **${gameTitleService.label(KING_TITLE)}**！這是你第 ${championCount} 次稱王，繼續用 /挖礦 守住王座 ⛏️`
        )
        .catch(() => {});
    }
  } catch (_) {
    /* noop */
  }

  // 週冠次數變動可能解鎖傳說礦工
  await gameTitleService
    .check(client, { userId: winnerId, guildId }, ["mining"])
    .catch(() => {});

  console.log(`[MINING] 週冠結算 guild=${guildId} winner=${winnerId}（第 ${championCount} 次）`.cyan);
  return { guildId, winnerId, championCount };
}

async function runWeeklyRank(client) {
  const window = rankService.previousWeekWindow();
  const guildIds = await guildsWithLogs(client, window);
  if (!guildIds.length) {
    console.log(`[MINING] 上週無挖礦紀錄，跳過週冠結算`.gray);
    return { processed: 0 };
  }
  let processed = 0;
  for (const guildId of guildIds) {
    try {
      const r = await processGuild(client, guildId);
      if (r) processed += 1;
    } catch (e) {
      console.log(`[MINING] 週冠結算失敗 guild=${guildId}: ${e.message}`.yellow);
    }
  }
  return { processed };
}

module.exports = async (client) => {
  if (!mining?.enabled) return;

  const cfg = mining?.weeklyRank || {};
  const timezone = cfg.timezone || "Asia/Taipei";
  registerCron(client, {
    name: "mining.weeklyRank",
    label: "挖礦週冠結算",
    schedule: cfg.cronSchedule || "1 0 * * 1",
    timezone,
    runner: () => runWeeklyRank(client),
  });

  // node-cron 不補跑錯過的排程：週一 00:01 卡在重啟 / 部署 / 斷線，那一週就不會
  // 頒王也不會公告。runWeeklyRank 已是冪等，開機後與每隔幾小時補跑一次即可自癒。
  registerCron(client, {
    name: "mining.weeklyRankCatchup",
    label: "挖礦週冠補跑",
    schedule: cfg.catchupCronSchedule || "9 */4 * * *",
    timezone,
    runner: () => runWeeklyRank(client),
  });

  setTimeout(() => {
    runWeeklyRank(client).catch((e) =>
      console.log(`[MINING] 開機補跑週冠結算失敗：${e?.message || e}`.yellow),
    );
  }, cfg.catchupBootDelayMs || 2 * 60 * 1000).unref?.();
};

module.exports.runWeeklyRank = runWeeklyRank;
