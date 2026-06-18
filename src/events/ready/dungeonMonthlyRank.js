// Phase H+ 月度副本征服者結算（dungeon_conqueror）
//
// 排名規則：每月 1 號 00:01 結算「上個月」每位玩家在 5F（含 mini-BOSS）的勝場數，
//   guild 內最高分頒予稱號；舊王自動卸任，與挖礦週冠模式完全對齊。
// 資料來源：DungeonRuns（result === "win"、floor === 5）。
// 若上月該 guild 無 5F 勝場，跳過該 guild。
//
// 不影響玩家流程：純記錄類 cron，失敗只 log。

require("colors");

const { DateTime } = require("luxon");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const { dungeon } = require("../../config");
const gameTitleService = require("../../features/gameTitles/gameTitleService");
const { plainifyUserMentions } = require("../../utils/plainifyUserMentions");

const TITLE_ID = "dungeon_conqueror";
const MEDALS = ["🥇", "🥈", "🥉"];
const TZ = "Asia/Taipei";

function previousMonthWindow() {
  const monthStart = DateTime.now().setZone(TZ).startOf("month");
  // ended_at 是 BSON Date，window 也用 Date 比對（不能用 number）
  return {
    start: monthStart.minus({ months: 1 }).toJSDate(),
    end: monthStart.toJSDate(),
    label: monthStart.minus({ months: 1 }).toFormat("yyyy 年 M 月"),
  };
}

// 依 DungeonRuns 加總「上個月 5F 勝場」排名。
async function rankByMonth(client, guildId, window, limit = 10) {
  if (!client?.dungeonRunsCollection) return [];
  return client.dungeonRunsCollection
    .aggregate([
      {
        $match: {
          guild_id: guildId,
          floor: 5,
          result: "win",
          ended_at: { $gte: window.start, $lt: window.end },
        },
      },
      { $group: { _id: "$user_id", clears: { $sum: 1 } } },
      { $sort: { clears: -1 } },
      { $limit: limit },
      { $project: { _id: 0, userId: "$_id", clears: 1 } },
    ])
    .toArray()
    .catch(() => []);
}

async function guildsWithRuns(client, window) {
  if (!client?.dungeonRunsCollection) return [];
  return client.dungeonRunsCollection
    .distinct("guild_id", {
      floor: 5,
      result: "win",
      ended_at: { $gte: window.start, $lt: window.end },
    })
    .catch(() => []);
}

async function dethronePrevious(client, guildId, winnerId) {
  if (!client.userLevelsCollection) return [];
  const prev = await client.userLevelsCollection
    .find({ guildId, gameTitles: TITLE_ID })
    .project({ userId: 1 })
    .toArray()
    .catch(() => []);
  const dethroned = [];
  for (const p of prev) {
    if (p.userId === winnerId) continue;
    await gameTitleService
      .revoke(client, { userId: p.userId, guildId, titleId: TITLE_ID, status: "revoked" })
      .catch(() => {});
    dethroned.push(p.userId);
  }
  return dethroned;
}

async function announceConqueror(client, guildId, winnerId, ranking, window, dethroned) {
  const announceChannelId = gameTitleService.announceChannelId();
  const channel = announceChannelId
    ? await client.channels.fetch(announceChannelId).catch(() => null)
    : null;
  if (!channel?.isTextBased?.()) return;

  const guild = client.guilds.cache.get(guildId);
  const lines = ranking.slice(0, 3).map((r, i) => {
    const medal = MEDALS[i] || "•";
    const display = plainifyUserMentions(guild, `<@${r.userId}>`);
    return `${medal} ${display}：${r.clears} 勝`;
  });
  const dethroneLine = dethroned.length
    ? `卸任：${dethroned.map((id) => plainifyUserMentions(guild, `<@${id}>`)).join("、")}`
    : "—";

  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# 🏆 ${window.label} 副本征服者結算`),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `恭喜 ${plainifyUserMentions(guild, `<@${winnerId}>`)} 拿下 **${gameTitleService.label(TITLE_ID)}**！\n` +
          `5F（含 mini-BOSS）通關 ${ranking[0].clears} 次，稱霸全月。`,
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### 月榜\n${lines.join("\n")}`),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${dethroneLine}`),
    );

  await channel
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
}

async function processGuild(client, guildId, window) {
  const ranking = await rankByMonth(client, guildId, window);
  if (!ranking.length) return null;

  const winnerId = ranking[0].userId;
  await gameTitleService
    .grant(client, {
      userId: winnerId,
      guildId,
      titleId: TITLE_ID,
      announce: false,
      source: "monthly_conqueror",
    })
    .catch(() => {});

  const dethroned = await dethronePrevious(client, guildId, winnerId);
  await announceConqueror(client, guildId, winnerId, ranking, window, dethroned);

  try {
    const winner = await client.users.fetch(winnerId).catch(() => null);
    if (winner) {
      await winner
        .send(
          `🏆 恭喜你拿下 **${gameTitleService.label(TITLE_ID)}**！${window.label} 5F 通關 ${ranking[0].clears} 次稱霸月榜。\n` +
            `-# 下個月歸零重算，繼續守住王座 ⚔️`,
        )
        .catch(() => {});
    }
  } catch (_) {
    /* noop */
  }

  console.log(
    `[DUNGEON] 月度副本征服者 guild=${guildId} winner=${winnerId} clears=${ranking[0].clears}（${window.label}）`.cyan,
  );
  return { guildId, winnerId, clears: ranking[0].clears };
}

async function runMonthlyRank(client) {
  const window = previousMonthWindow();
  const guildIds = await guildsWithRuns(client, window);
  if (!guildIds.length) {
    console.log(`[DUNGEON] ${window.label} 無 5F 勝場，跳過月榜結算`.gray);
    return { processed: 0 };
  }
  let processed = 0;
  for (const guildId of guildIds) {
    try {
      const r = await processGuild(client, guildId, window);
      if (r) processed += 1;
    } catch (e) {
      console.log(`[DUNGEON] 月榜結算失敗 guild=${guildId}: ${e.message}`.yellow);
    }
  }
  return { processed };
}

module.exports = async (client) => {
  if (!dungeon?.enabled) return;

  registerCron(client, {
    name: "dungeon.monthlyRank",
    label: "副本征服者月榜結算",
    // 每月 1 號 00:01 跑（同時區）
    schedule: "1 0 1 * *",
    timezone: TZ,
    runner: () => runMonthlyRank(client),
  });
};
