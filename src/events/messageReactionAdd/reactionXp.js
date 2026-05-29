require("colors");
const { DateTime } = require("luxon");
const { levelSystem, coinSystem, questSystem } = require("../../config");
const grantXp = require("../../features/leveling/grantXp");
const grantCoins = require("../../features/economy/grantCoins");
const questService = require("../../features/quests/questService");
const notifyQuestClaim = require("../../features/quests/notifyQuestClaim");

const COOLDOWN_MS = 30 * 1000;

module.exports = async (client, reaction, user) => {
  try {
    if (!levelSystem?.enabled) return;
    if (!client.userLevelsCollection || !client.levelTransactionsCollection) return;

    const cfg = levelSystem.reaction;
    if (!cfg || !cfg.xpPerReactionReceived) return;

    if (user.bot) return;

    // partial reactions 需 fetch
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }
    const message = reaction.message;
    if (message.partial) {
      try {
        await message.fetch();
      } catch {
        return;
      }
    }
    if (!message.guild) return;
    if (!message.author || message.author.bot) return;

    // 不給自己加 reaction 的 XP
    if (message.author.id === user.id) return;

    // Cooldown 改用 DB 查詢：同一個 (reactor, author) 配對 30 秒一次
    const recent = await client.levelTransactionsCollection.findOne(
      {
        userId: message.author.id,
        guildId: message.guild.id,
        source: "reaction",
        "meta.reactorId": user.id,
        createdAt: { $gt: new Date(Date.now() - COOLDOWN_MS) },
      },
      { projection: { _id: 1 } },
    );
    if (recent) return;

    // 每日 cap：累積今天 author 已經從 reaction 拿了多少 XP
    const tz = levelSystem.daily?.resetTimezone || "Asia/Taipei";
    const today = DateTime.now().setZone(tz).toISODate();
    const cap = cfg.dailyCapPerUser ?? 50;

    const todayAgg = await client.levelTransactionsCollection
      .aggregate([
        {
          $match: {
            userId: message.author.id,
            guildId: message.guild.id,
            source: "reaction",
            date: today,
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ])
      .toArray();
    const earnedToday = todayAgg[0]?.total || 0;
    if (earnedToday >= cap) return;

    const xp = Math.min(cfg.xpPerReactionReceived, cap - earnedToday);

    // 給訊息作者 XP
    const authorMember = await message.guild.members
      .fetch(message.author.id)
      .catch(() => null);

    await grantXp(client, {
      userId: message.author.id,
      guildId: message.guild.id,
      username: message.author.username,
      avatarHash: message.author.avatar,
      amount: xp,
      source: "reaction",
      counterField: "xpFromReaction",
      incrementReactionsReceived: 1,
      meta: {
        channelId: message.channelId,
        messageId: message.id,
        reactorId: user.id,
        emoji: reaction.emoji?.name || "?",
      },
      channel: message.channel,
      member: authorMember,
    });

    // 反應金幣：每 N 個反應給 1 金幣（counter 存在 userCoinsCollection 上）
    await tryGrantReactionCoin(client, message, authorMember, today, user, reaction);

    // 人氣王任務：作者本週收到反應 +1（已排除自反應 + 同 reactor 30s cooldown）
    if (questSystem?.enabled && client.questProgressCollection) {
      const claimCtx = {
        member: authorMember,
        username: message.author.username,
      };
      const notifyCtx = {
        user: message.author,
        userId: message.author.id,
        guildId: message.guild.id,
      };
      questService
        .incrementProgress(
          client,
          message.author.id,
          message.guild.id,
          "weekly_popular",
          1,
          claimCtx
        )
        .then((res) => {
          if (res?.autoClaimed) {
            notifyQuestClaim(client, notifyCtx, res.autoClaimed).catch(() => {});
          }
        })
        .catch((e) => console.log(`[ERROR] quest weekly_popular: ${e}`.red));
    }
  } catch (error) {
    console.log(`[ERROR] reactionXp:\n${error}`.red);
  }
};

async function tryGrantReactionCoin(client, message, authorMember, today, reactor, reaction) {
  if (!coinSystem?.enabled) return;
  if (!client.userCoinsCollection || !client.coinTransactionsCollection) return;
  const cfg = coinSystem.reaction;
  if (!cfg) return;
  const reactionsPerCoin = cfg.reactionsPerCoin ?? 2;
  if (reactionsPerCoin <= 0) return;

  // atomic counter：每滿 reactionsPerCoin 才給 1 金幣
  const update = await client.userCoinsCollection.findOneAndUpdate(
    { userId: message.author.id, guildId: message.guild.id },
    {
      $inc: { reactionCounter: 1 },
      $setOnInsert: {
        userId: message.author.id,
        guildId: message.guild.id,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  const after = update.value || update;
  const counter = after?.reactionCounter || 0;
  if (counter < reactionsPerCoin) return;

  // 達標 → 重置計數，發 1 金幣
  await client.userCoinsCollection.updateOne(
    { userId: message.author.id, guildId: message.guild.id },
    { $set: { reactionCounter: 0 } },
  );

  await grantCoins(client, {
    userId: message.author.id,
    guildId: message.guild.id,
    username: message.author.username,
    avatarHash: message.author.avatar,
    amount: 1,
    source: "reaction",
    meta: {
      channelId: message.channelId,
      messageId: message.id,
      reactorId: reactor.id,
      emoji: reaction.emoji?.name || "?",
    },
    member: authorMember,
  });
}
