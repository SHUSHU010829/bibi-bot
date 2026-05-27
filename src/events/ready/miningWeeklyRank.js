require("colors");

const cron = require("node-cron");
const { EmbedBuilder } = require("discord.js");

const { mining } = require("../../config");
const rankService = require("../../features/mining/rankService");
const titleManager = require("../../features/mining/titleManager");
const achievementChecker = require("../../features/mining/achievementChecker");

const KING_TITLE = "mine_king";
const MEDALS = ["🥇", "🥈", "🥉"];

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;

// 取出上週有挖礦紀錄的所有 guild。
async function guildsWithLogs(client, window) {
  if (!client.mineLogsCollection) return [];
  return client.mineLogsCollection
    .distinct("guild_id", { ts: { $gte: window.start, $lt: window.end } })
    .catch(() => []);
}

async function fetchMember(client, guildId, userId) {
  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) return null;
  return guild.members.fetch(userId).catch(() => null);
}

// 卸下上一任礦坑之王（贏家除外）。
async function dethronePrevious(client, guildId, winnerId) {
  if (!client.miningProfilesCollection) return;
  const prev = await client.miningProfilesCollection
    .find({ guildId, unlocked_titles: KING_TITLE })
    .toArray()
    .catch(() => []);
  for (const p of prev) {
    if (p.userId === winnerId) continue;
    const member = await fetchMember(client, guildId, p.userId);
    await titleManager
      .revokeTitle(client, { userId: p.userId, guildId, member, titleId: KING_TITLE })
      .catch(() => {});
  }
}

async function announceKing(client, guildId, winnerId, ranking, championCount) {
  const channelId = titleManager.announceChannelId();
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  const top = ranking
    .slice(0, 3)
    .map((r, i) => `${MEDALS[i]} <@${r.userId}> — **${r.total.toLocaleString()}** 顆`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle("👑 上週礦坑之王出爐！")
    .setDescription(
      `恭喜 <@${winnerId}> 拿下上週挖礦榜冠軍，獲得稱號 **${titleManager.titleLabel(KING_TITLE)}**！\n` +
        `這是他第 **${championCount}** 次稱王 👑`
    )
    .addFields({ name: "上週前三名", value: top || "—" })
    .setFooter({ text: "新的一週開始了，用 /挖礦 角逐本週王座！" })
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] }).catch(() => {});
}

async function processGuild(client, guildId) {
  const window = rankService.previousWeekWindow();
  const ranking = await rankService.rankByWindow(client, guildId, { ...window, limit: 10 });
  if (!ranking.length) return;

  const winnerId = ranking[0].userId;
  const winnerMember = await fetchMember(client, guildId, winnerId);

  // 先頒給新王（idempotent），再卸下舊王
  await titleManager
    .grantTitle(client, { userId: winnerId, guildId, member: winnerMember, titleId: KING_TITLE })
    .catch(() => {});

  const updated = await client.miningProfilesCollection
    .findOneAndUpdate(
      { userId: winnerId, guildId },
      { $inc: { weekly_champion_count: 1 }, $set: { updatedAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    )
    .catch(() => null);
  const championCount = (updated?.value || updated)?.weekly_champion_count || 1;

  await dethronePrevious(client, guildId, winnerId);
  await announceKing(client, guildId, winnerId, ranking, championCount);

  // 週冠次數變動可能解鎖傳說礦工
  await achievementChecker
    .checkAndGrant(client, { userId: winnerId, guildId, member: winnerMember })
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
