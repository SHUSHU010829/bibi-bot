require("colors");
const { DateTime } = require("luxon");
const { getLevelProgress } = require("../../utils/levelMath");
const { levelSystem, coinSystem } = require("../../config");
const { getCurrentMultiplier } = require("../../utils/xpMultiplier");
const { getTwitchSubBonus } = require("../../utils/twitchSubBonus");
const { getServerBoostBonus } = require("../../utils/serverBoostBonus");
const syncLevelRoles = require("./levelRoles");
const announceLevelUp = require("./levelUpAnnouncer");
const checkBadges = require("./badgeChecker");
const grantCoins = require("../economy/grantCoins");
const { getActiveBuffMultiplier } = require("../shop/activeBuff");

module.exports = async (client, opts) => {
  if (!client.userLevelsCollection) return null;
  if (!opts.amount || opts.amount <= 0) return null;

  const tz = levelSystem?.daily?.resetTimezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();

  // XP 倍率事件（admin/boost 一次性 grant 不套用倍率）
  const skipMultipliers = ["admin", "boost"].includes(opts.source);
  const eventInfo = skipMultipliers
    ? { multiplier: 1, names: [] }
    : getCurrentMultiplier(opts.source, DateTime.now().setZone(tz));
  const twitchInfo = skipMultipliers
    ? { multiplier: 1, name: null }
    : getTwitchSubBonus(opts.member, opts.source);
  const boostInfo = skipMultipliers
    ? { multiplier: 1, name: null }
    : getServerBoostBonus(opts.member, opts.source);
  const baseAmount = opts.amount;
  const buffMultiplier = skipMultipliers
    ? 1
    : await getActiveBuffMultiplier(client, opts.userId, opts.guildId, "xp_boost").catch(() => 1);
  // 世界事件 XP 加成（xp_boost_pct）
  const worldEventXpMult = skipMultipliers
    ? 1
    : require("../world_event/worldEventBuffs").getXpMultiplier();
  const totalMultiplier =
    eventInfo.multiplier *
    twitchInfo.multiplier *
    boostInfo.multiplier *
    buffMultiplier *
    worldEventXpMult;
  if (totalMultiplier > 1) {
    opts.amount = Math.floor(opts.amount * totalMultiplier);
  }

  if (client.levelTransactionsCollection) {
    client.levelTransactionsCollection
      .insertOne({
        userId: opts.userId,
        guildId: opts.guildId,
        amount: opts.amount,
        source: opts.source,
        meta: opts.meta || {},
        date: today,
        createdAt: new Date(),
      })
      .catch((e) =>
        console.log(`[ERROR] insert level transaction: ${e}`.red)
      );
  }

  const counterField = opts.counterField || `xpFrom_${opts.source}`;
  const inc = {
    totalXp: opts.amount,
    [counterField]: opts.amount,
  };
  if (opts.incrementMessages) inc.totalMessages = 1;
  if (opts.incrementVoiceMinutes) inc.totalVoiceMinutes = opts.incrementVoiceMinutes;
  if (opts.incrementReactionsReceived)
    inc.totalReactionsReceived = opts.incrementReactionsReceived;

  const setOnInsert = {
    userId: opts.userId,
    guildId: opts.guildId,
    streak: 0,
    longestStreak: 0,
    totalCheckins: 0,
    badges: [],
    title: null,
    cardAccent: levelSystem?.card?.defaultAccent || "default",
    createdAt: new Date(),
  };

  const set = {
    username: opts.username,
    updatedAt: new Date(),
  };
  if (opts.avatarHash !== undefined) set.avatarHash = opts.avatarHash;

  const result = await client.userLevelsCollection.findOneAndUpdate(
    { userId: opts.userId, guildId: opts.guildId },
    { $inc: inc, $set: set, $setOnInsert: setOnInsert },
    { upsert: true, returnDocument: "after" }
  );

  const after = result.value || result;
  if (!after) return null;

  // 用 findOneAndUpdate 之後反推 beforeXp，避免 findOne→update 之間的 race
  const beforeXp = Math.max(0, (after.totalXp || 0) - opts.amount);
  const beforeLevel = getLevelProgress(beforeXp).level;

  const afterProgress = getLevelProgress(after.totalXp);
  const afterLevel = afterProgress.level;

  if (after.level !== afterLevel) {
    await client.userLevelsCollection.updateOne(
      { _id: after._id },
      { $set: { level: afterLevel } }
    );
    after.level = afterLevel;
  }

  // 徽章檢查（先寫 DB，拿到本次新解鎖的徽章，由呼叫端決定要不要顯示）
  let newlyUnlocked = [];
  try {
    newlyUnlocked = await checkBadges(client, after);
    if (newlyUnlocked.length > 0) {
      after.badges = [
        ...(after.badges || []),
        ...newlyUnlocked.map((b) => b.id),
      ];
    }
  } catch (e) {
    console.log(`[ERROR] checkBadges: ${e}`.red);
  }

  if (afterLevel > beforeLevel) {
    console.log(
      `[LEVEL] ${opts.username} ${beforeLevel} → ${afterLevel} (+${opts.amount} from ${opts.source})`.cyan
    );

    // 升級金幣獎勵（每升一級 → level × coinsPerLevel；觸到 milestone → 額外發放）
    if (coinSystem?.enabled && client.userCoinsCollection) {
      const coinsPerLevel = coinSystem.levelUp?.coinsPerLevel ?? 0;
      const softCapLevel = coinSystem.levelUp?.softCapLevel ?? 0;
      const softCapDivisor = coinSystem.levelUp?.softCapDivisor ?? 1;
      const milestones = coinSystem.levelUp?.milestones || {};
      for (let lv = beforeLevel + 1; lv <= afterLevel; lv += 1) {
        if (coinsPerLevel > 0) {
          let coinReward = lv * coinsPerLevel;
          if (softCapLevel > 0 && lv > softCapLevel && softCapDivisor > 1) {
            const baseAtCap = softCapLevel * coinsPerLevel;
            const overflow = (lv - softCapLevel) * coinsPerLevel;
            coinReward = baseAtCap + Math.floor(overflow / softCapDivisor);
          }
          grantCoins(client, {
            userId: opts.userId,
            guildId: opts.guildId,
            username: opts.username,
            avatarHash: opts.avatarHash,
            amount: coinReward,
            source: "levelup",
            meta: { level: lv },
            member: opts.member,
          }).catch((e) =>
            console.log(`[ERROR] grantCoins levelup: ${e}`.red)
          );
        }
        const msReward = milestones[String(lv)];
        if (msReward && msReward > 0) {
          grantCoins(client, {
            userId: opts.userId,
            guildId: opts.guildId,
            username: opts.username,
            avatarHash: opts.avatarHash,
            amount: msReward,
            source: "milestone",
            meta: { level: lv },
            member: opts.member,
          }).catch((e) =>
            console.log(`[ERROR] grantCoins milestone: ${e}`.red)
          );
        }
      }
    }

    // 等級身分組同步（fire-and-forget，失敗不影響回傳）
    if (opts.member) {
      syncLevelRoles(client, opts.member, afterLevel).catch((e) =>
        console.log(`[ERROR] syncLevelRoles: ${e}`.red)
      );
    }

    // 升級公告（內部會判斷是否 milestone），同時把當下解鎖的徽章帶下去
    announceLevelUp(client, {
      member: opts.member,
      guildId: opts.guildId,
      channel: opts.channel,
      beforeLevel,
      afterLevel,
      after,
      newBadges: newlyUnlocked,
    }).catch((e) => console.log(`[ERROR] announceLevelUp: ${e}`.red));
  }

  return {
    before: beforeLevel,
    after: afterLevel,
    doc: after,
    newBadges: newlyUnlocked,
    baseAmount,
    grantedAmount: opts.amount,
    eventNames: eventInfo.names,
    multiplier: totalMultiplier,
    eventMultiplier: eventInfo.multiplier,
    twitchSubName: twitchInfo.name,
    twitchSubMultiplier: twitchInfo.multiplier,
    boostBonusName: boostInfo.name,
    boostBonusMultiplier: boostInfo.multiplier,
  };
};
