require("colors");
const { DateTime } = require("luxon");
const { levelSystem, coinSystem, questSystem } = require("../../config");
const { isMessageXpEligible, isMessageRepetitive } = require("../../utils/xpGuards");
const { randomInt } = require("../../utils/levelMath");
const grantXp = require("../../features/leveling/grantXp");
const grantCoins = require("../../features/economy/grantCoins");
const chatRewardBuffer = require("../../features/economy/chatRewardBuffer");
const questService = require("../../features/quests/questService");
const notifyQuestClaim = require("../../features/quests/notifyQuestClaim");
const { getQuestById } = require("../../features/quests/questDefinitions");

module.exports = async (client, message) => {
  try {
    if (!levelSystem?.enabled) return;
    if (!client.userLevelsCollection) return;
    if (!client.levelTransactionsCollection) return;

    const cfg = levelSystem.message;
    if (!isMessageXpEligible(message, cfg)) return;

    if (isMessageRepetitive(message.author.id, message.content.trim())) return;

    // 任務進度先更新（不受 XP cooldown 影響，玩家連發 10 則會正常計數）
    await tryUpdateMessageQuests(client, message);

    // Cooldown 改用 DB 查詢（去除 per-process Map，sharding-safe）
    const cooldownMs = (cfg.cooldownSeconds || 30) * 1000;
    const recent = await client.levelTransactionsCollection.findOne(
      {
        userId: message.author.id,
        guildId: message.guildId,
        source: "message",
        createdAt: { $gt: new Date(Date.now() - cooldownMs) },
      },
      { projection: { _id: 1 } },
    );
    if (recent) return;

    const xp = randomInt(cfg.minXp, cfg.maxXp);

    await grantXp(client, {
      userId: message.author.id,
      guildId: message.guildId,
      username: message.author.username,
      avatarHash: message.author.avatar,
      amount: xp,
      source: "message",
      counterField: "xpFromMessage",
      incrementMessages: true,
      meta: { channelId: message.channelId, messageId: message.id },
      channel: message.channel,
      member: message.member,
    });

    // 訊息金幣（獨立冷卻 + 每日上限合計於 grantCoins 內處理）
    await tryGrantMessageCoins(client, message);
  } catch (error) {
    console.log(`[ERROR] messageXp:\n${error}`.red);
  }
};

async function tryGrantMessageCoins(client, message) {
  if (!coinSystem?.enabled) return;
  if (!client.userCoinsCollection || !client.coinTransactionsCollection) return;
  const cfg = coinSystem.message;
  if (!cfg) return;

  // 獨立冷卻：buffer 化後改讀 chatBuffer.lastAt.message（已 flush 的舊紀錄不再查 CoinTransactions）
  const cooldownMs = (cfg.cooldownSeconds || 60) * 1000;
  const lastAt = await chatRewardBuffer.getLastChatAt(
    client,
    message.author.id,
    message.guildId,
    "message",
  );
  if (lastAt && Date.now() - lastAt.getTime() < cooldownMs) return;

  const minC = cfg.minCoins ?? 0;
  const maxC = cfg.maxCoins ?? 2;
  const coins = randomInt(minC, maxC);
  if (coins <= 0) return; // 落空：不寫 transaction

  await grantCoins(client, {
    userId: message.author.id,
    guildId: message.guildId,
    username: message.author.username,
    avatarHash: message.author.avatar,
    amount: coins,
    source: "message",
    meta: { channelId: message.channelId, messageId: message.id },
    member: message.member,
  });
}

async function tryUpdateMessageQuests(client, message) {
  if (!questSystem?.enabled) return;
  if (!client.questProgressCollection) return;
  try {
    const userId = message.author.id;
    const guildId = message.guildId;
    const claimCtx = {
      member: message.member,
      username: message.author.username,
    };
    const notifyCtx = { user: message.author, userId, guildId };

    const dailyMsgRes = await questService
      .incrementProgress(client, userId, guildId, "daily_messages", 1, claimCtx)
      .catch((e) => {
        console.log(`[ERROR] quest daily_messages: ${e}`.red);
        return null;
      });
    if (dailyMsgRes?.autoClaimed) {
      await notifyQuestClaim(client, notifyCtx, dailyMsgRes.autoClaimed);
    }

    const weeklyMsgRes = await questService
      .incrementProgress(client, userId, guildId, "weekly_messages", 1, claimCtx)
      .catch((e) => {
        console.log(`[ERROR] quest weekly_messages: ${e}`.red);
        return null;
      });
    if (weeklyMsgRes?.autoClaimed) {
      await notifyQuestClaim(client, notifyCtx, weeklyMsgRes.autoClaimed);
    }

    const morningDef = getQuestById("daily_morning");
    if (morningDef && morningDef.morningChannelId) {
      if (message.channelId === morningDef.morningChannelId) {
        const tz = questSystem.resetTimezone || "Asia/Taipei";
        const hour = DateTime.now().setZone(tz).hour;
        const startH = morningDef.morningStartHour ?? 7;
        const endH = morningDef.morningEndHour ?? 10;
        if (hour >= startH && hour < endH) {
          const morningRes = await questService
            .markCompleted(client, userId, guildId, "daily_morning", claimCtx)
            .catch((e) => {
              console.log(`[ERROR] quest daily_morning: ${e}`.red);
              return null;
            });
          if (morningRes?.autoClaimed) {
            await notifyQuestClaim(client, notifyCtx, morningRes.autoClaimed);
          }
        }
      }
    }
  } catch (e) {
    console.log(`[ERROR] tryUpdateMessageQuests: ${e}`.red);
  }
}
