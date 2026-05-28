require("colors");

const cron = require("node-cron");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { mining } = require("../../config");
const rankService = require("../../features/mining/rankService");
const gameTitleService = require("../../features/gameTitles/gameTitleService");

const KING_TITLE = "mine_king";
const MEDALS = ["🥇", "🥈", "🥉"];

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;

async function guildsWithLogs(client, window) {
  if (!client.mineLogsCollection) return [];
  return client.mineLogsCollection
    .distinct("guild_id", { ts: { $gte: window.start, $lt: window.end } })
    .catch(() => []);
}

// 卸下上一任礦坑之王（贏家除外）。解鎖清單存在 UserLevels.gameTitles。
async function dethronePrevious(client, guildId, winnerId) {
  if (!client.userLevelsCollection) return;
  const prev = await client.userLevelsCollection
    .find({ guildId, gameTitles: KING_TITLE })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  for (const p of prev) {
    if (p.userId === winnerId) continue;
    await gameTitleService
      .revoke(client, { userId: p.userId, guildId, titleId: KING_TITLE })
      .catch(() => {});
  }
}

async function announceKing(client, winnerId, ranking, championCount) {
  const channelId = gameTitleService.announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const top = ranking
    .slice(0, 3)
    .map((r, i) => `${MEDALS[i]} <@${r.userId}> — **${r.total.toLocaleString()}** 顆`)
    .join("\n");

  const container = new ContainerBuilder()
    .setAccentColor(0xffd700)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 👑 上週礦坑之王出爐！\n` +
          `恭喜 <@${winnerId}> 拿下上週挖礦榜冠軍，獲得稱號 **${gameTitleService.label(KING_TITLE)}**！\n` +
          `這是他第 **${championCount}** 次稱王 👑`,
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

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch(() => {});
}

async function processGuild(client, guildId) {
  const window = rankService.previousWeekWindow();
  const ranking = await rankService.rankByWindow(client, guildId, { ...window, limit: 10 });
  if (!ranking.length) return;

  const winnerId = ranking[0].userId;

  // 先頒給新王（idempotent，自行做專屬公告所以關掉預設公告），再卸下舊王
  await gameTitleService
    .grant(client, { userId: winnerId, guildId, titleId: KING_TITLE, announce: false })
    .catch(() => {});

  const updated = await client.miningProfilesCollection
    ?.findOneAndUpdate(
      { userId: winnerId, guildId },
      { $inc: { weekly_champion_count: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    )
    .catch(() => null);
  const championCount = (updated?.value || updated)?.weekly_champion_count || 1;

  await dethronePrevious(client, guildId, winnerId);
  await announceKing(client, winnerId, ranking, championCount);

  // 週冠次數變動可能解鎖傳說礦工
  await gameTitleService
    .check(client, { userId: winnerId, guildId }, ["mining"])
    .catch(() => {});

  console.log(`[MINING] 週冠結算 guild=${guildId} winner=${winnerId}（第 ${championCount} 次）`.cyan);
}

async function runWeeklyRank(client) {
  const window = rankService.previousWeekWindow();
  const guildIds = await guildsWithLogs(client, window);
  if (!guildIds.length) {
    console.log(`[MINING] 上週無挖礦紀錄，跳過週冠結算`.gray);
    return;
  }
  for (const guildId of guildIds) {
    await processGuild(client, guildId).catch((e) =>
      console.log(`[MINING] 週冠結算失敗 guild=${guildId}: ${e.message}`.yellow)
    );
  }
}

module.exports = async (client) => {
  if (task) return;
  if (!mining?.enabled) return;

  const cfg = mining?.weeklyRank || {};
  const schedule = cfg.cronSchedule || "1 0 * * 1";
  const tz = cfg.timezone || "Asia/Taipei";

  task = cron.schedule(
    schedule,
    async () => {
      try {
        await runWeeklyRank(client);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.log(
          `[ERROR] miningWeeklyRank failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(`[ERROR] 連續錯誤過多，停止週冠 cron`.red);
          task.stop();
        }
      }
    },
    { timezone: tz }
  );

  console.log(`[MINING] 挖礦週冠排程已啟動：${schedule} (${tz})`.cyan);
};
