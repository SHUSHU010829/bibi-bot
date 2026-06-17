require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");
const { mining } = require("../../config");
const rankService = require("./rankService");

const DEFAULT_FLAVORS = [
  "礦坑深處震動了一下，傳說又多一筆。",
  "鑽石的光芒驚動了林中精靈。",
  "金光黨見了都會嫉妒。",
  "今日份的「歐皇認證」蓋章完畢。",
  "礦工協會：請問還缺打雜的嗎？",
  "據說這顆鑽石還沒落地就被人估了三次價。",
  "BGM 自動切到「Diamonds」(Rihanna)。",
];

const SOURCE_VERBS = {
  mine: "透過 `/挖礦` 挖到了",
  appraise: "透過 賭石 開出了",
  dungeon: "在地下城找到了",
  encounter: "在挖礦奇遇中拾獲了",
};

function pickFlavor({ userDiamonds, rank, todayCount, source }) {
  if (userDiamonds === 1) return "🎉 人生第一顆鑽石！這手感是不是癢起來想再挖一把？";
  if (rank === 1) return "👑 目前坐穩全服鑽石榜首！";
  if (rank && rank <= 3) return `🏆 一舉躍上鑽石獵人榜 第 ${rank} 名！`;
  if (todayCount === 1) return "💫 今日全服第一顆鑽石，開張大吉！";
  if (todayCount >= 5) return `🔥 今天礦坑鑽光閃閃，已經第 ${todayCount} 顆！`;
  if (userDiamonds > 0 && userDiamonds % 10 === 0) {
    return `🎯 達成累計 **${userDiamonds}** 顆鑽石里程碑！`;
  }
  if (source === "appraise") {
    return "🔍 鑑定師抬頭笑了一下，手沒抖過。";
  }
  return DEFAULT_FLAVORS[Math.floor(Math.random() * DEFAULT_FLAVORS.length)];
}

async function fetchStats(client, { userId, guildId }) {
  const { start, end } = rankService.periodWindow("today");
  const [profile, todayCount, userTodayCount, totalRow] = await Promise.all([
    client.miningProfilesCollection
      .findOne(
        { userId, guildId },
        { projection: { "lifetime_ore.diamond": 1 } },
      )
      .catch(() => null),
    client.mineLogsCollection
      .aggregate([
        {
          $match: {
            guild_id: guildId,
            ore: "diamond",
            ts: { $gte: start, $lt: end },
          },
        },
        { $group: { _id: null, total: { $sum: "$qty" } } },
      ])
      .toArray()
      .catch(() => [])
      .then((rows) => rows[0]?.total || 0),
    client.mineLogsCollection
      .aggregate([
        {
          $match: {
            guild_id: guildId,
            user_id: userId,
            ore: "diamond",
            ts: { $gte: start, $lt: end },
          },
        },
        { $group: { _id: null, total: { $sum: "$qty" } } },
      ])
      .toArray()
      .catch(() => [])
      .then((rows) => rows[0]?.total || 0),
    client.miningProfilesCollection
      .aggregate([
        { $match: { guildId, "lifetime_ore.diamond": { $gt: 0 } } },
        {
          $group: {
            _id: null,
            total: { $sum: "$lifetime_ore.diamond" },
            hunters: { $sum: 1 },
          },
        },
      ])
      .toArray()
      .catch(() => [])
      .then((rows) => rows[0] || { total: 0, hunters: 0 }),
  ]);

  const userDiamonds = profile?.lifetime_ore?.diamond || 0;
  let rank = null;
  if (userDiamonds > 0) {
    const higher = await client.miningProfilesCollection
      .countDocuments({
        guildId,
        "lifetime_ore.diamond": { $gt: userDiamonds },
      })
      .catch(() => null);
    if (higher != null) rank = higher + 1;
  }

  return {
    userDiamonds,
    userTodayCount,
    todayCount,
    serverTotal: totalRow.total,
    hunters: totalRow.hunters,
    rank,
  };
}

async function announceDiamond(client, { user, guildId, source = "mine", qty = 1, fallbackChannel } = {}) {
  if (!user || !guildId) return;
  if (!client.miningProfilesCollection || !client.mineLogsCollection) return;

  const diamondDef = mining?.ores?.diamond || {};
  const diamondEmoji = diamondDef.emoji || "💎";

  // 只有 /挖礦 會在 mineService 把鑽石寫進 mineLogs；賭石 / 地下城 / 突發事件 只更新
  // lifetime_ore。這裡為非 mine 來源補寫一筆 mineLogs，讓「今日全服挖出」等每日聚合
  // 真正累計進去（之前只在當下訊息加數字，沒落地，所以下一則公告就消失了）。
  const addQty = Math.max(0, Math.floor(Number(qty) || 0));
  if (source !== "mine" && addQty > 0) {
    await client.mineLogsCollection
      .insertOne({
        user_id: user.id,
        guild_id: guildId,
        ore: "diamond",
        qty: addQty,
        ts: new Date(),
        source,
      })
      .catch((e) => console.log(`[WARN] 鑽石寫入 mineLogs 失敗：${e.message}`.yellow));
  }

  let stats;
  try {
    stats = await fetchStats(client, { userId: user.id, guildId });
  } catch (e) {
    console.log(`[WARN] 鑽石播報統計失敗：${e.message}`.yellow);
    stats = { userDiamonds: 0, userTodayCount: 0, todayCount: 0, serverTotal: 0, hunters: 0, rank: null };
  }

  const verb = SOURCE_VERBS[source] || SOURCE_VERBS.mine;
  const flavor = pickFlavor({ ...stats, source });
  const rankLine = stats.rank
    ? `第 **${stats.rank}** / ${stats.hunters} 名`
    : "尚未上榜";

  const container = new ContainerBuilder().setAccentColor(0x67e8f9);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## ${diamondEmoji} 鑽石閃耀全服！\n` +
        `<@${user.id}> ${verb}傳說中的 **鑽石**！\n` +
        `-# ${flavor}`,
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**個人累計**　**${stats.userDiamonds.toLocaleString()}** 顆（今日 **${stats.userTodayCount.toLocaleString()}** 顆）\n` +
        `**鑽石獵人榜**　${rankLine}\n` +
        `**今日全服挖出**　**${stats.todayCount.toLocaleString()}** 顆\n` +
        `**全服累計**　**${stats.serverTotal.toLocaleString()}** 顆`,
    ),
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# 輸入 `/排行榜 鑽石獵人` 看完整榜單"),
  );

  const payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };

  try {
    const channelId = mining?.diamondAnnounceChannelId || mining?.announceChannelId;
    if (channelId) {
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (ch?.isTextBased?.()) {
        await ch.send(payload);
        return;
      }
    }
    if (fallbackChannel?.isTextBased?.()) {
      await fallbackChannel.send(payload);
    }
  } catch (e) {
    console.log(`[WARN] 鑽石公告送出失敗：${e.message}`.yellow);
  }
}

module.exports = { announceDiamond };
