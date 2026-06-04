require("colors");
const { DateTime } = require("luxon");
const { questSystem } = require("../../config");
const { dailyQuests, weeklyQuests } = require("./questDefinitions");
const grantCoins = require("../economy/grantCoins");

const TZ = () => questSystem?.resetTimezone || "Asia/Taipei";

const cfg = () => questSystem?.assignment || {};
const isEnabled = () => cfg().enabled !== false;

const periodFor = (tier) => {
  if (tier === "weekly") {
    return DateTime.now().setZone(TZ()).toFormat("kkkk-'W'WW");
  }
  return DateTime.now().setZone(TZ()).toISODate();
};

const poolFor = (tier) => (tier === "weekly" ? weeklyQuests() : dailyQuests());
const poolSizeFor = (tier) =>
  tier === "weekly" ? cfg().weeklyPoolSize ?? 4 : cfg().dailyPoolSize ?? 5;
const rerollCostFor = (tier) => cfg().rerollCost?.[tier] ?? (tier === "weekly" ? 200 : 100);
const skipCostFor = (tier) => cfg().skipCost?.[tier] ?? (tier === "weekly" ? 100 : 30);
const actionLimitFor = (tier) => cfg().actionLimit?.[tier] ?? (tier === "weekly" ? 2 : 4);

function pickRandomIds(pool, n) {
  const ids = pool.map((q) => q.id);
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(n, ids.length));
}

async function getOrCreateAssignment(client, userId, guildId, tier) {
  if (!client.questAssignmentsCollection) return null;
  const period = periodFor(tier);
  const existing = await client.questAssignmentsCollection.findOne({
    userId,
    guildId,
    tier,
    period,
  });
  if (existing) return existing;

  const pool = poolFor(tier);
  if (pool.length === 0) return null;
  const size = Math.min(poolSizeFor(tier), pool.length);
  const quests = pickRandomIds(pool, size);
  const now = new Date();

  const upserted = await client.questAssignmentsCollection.findOneAndUpdate(
    { userId, guildId, tier, period },
    {
      $setOnInsert: {
        userId,
        guildId,
        tier,
        period,
        quests,
        skipped: [],
        rerollsUsed: 0,
        skipsUsed: 0,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  return upserted?.value || upserted;
}

// 是否為玩家本期指派的任務（未指派 / 已 skip → false）。
// assignment 未啟用時退回「全部視為已指派」相容舊行為。
async function isQuestAssigned(client, userId, guildId, tier, questId) {
  if (!isEnabled()) return true;
  const a = await getOrCreateAssignment(client, userId, guildId, tier);
  if (!a) return false;
  if (!a.quests?.includes(questId)) return false;
  if (a.skipped?.includes(questId)) return false;
  return true;
}

async function rerollQuest(client, userId, guildId, tier, questId, opts = {}) {
  if (!isEnabled()) return { ok: false, reason: "disabled" };
  if (!client.questAssignmentsCollection || !client.questProgressCollection) {
    return { ok: false, reason: "disabled" };
  }

  const assignment = await getOrCreateAssignment(client, userId, guildId, tier);
  if (!assignment) return { ok: false, reason: "no_assignment" };
  if (!assignment.quests?.includes(questId)) return { ok: false, reason: "not_in_pool" };
  if (assignment.skipped?.includes(questId)) return { ok: false, reason: "already_skipped" };

  const period = assignment.period;
  const progress = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (progress?.claimed) return { ok: false, reason: "already_claimed" };

  const limit = actionLimitFor(tier);
  const used = (assignment.rerollsUsed || 0) + (assignment.skipsUsed || 0);
  if (used >= limit) {
    return { ok: false, reason: "over_limit", used, limit };
  }

  const poolIds = poolFor(tier).map((q) => q.id);
  const exclude = new Set([...(assignment.quests || []), ...(assignment.skipped || [])]);
  const candidates = poolIds.filter((id) => !exclude.has(id));
  if (candidates.length === 0) return { ok: false, reason: "pool_exhausted" };
  const newQuestId = candidates[Math.floor(Math.random() * candidates.length)];

  // 用 $expr 原子檢查「rerollsUsed + skipsUsed < limit」，避免併發超額
  const swap = await client.questAssignmentsCollection.findOneAndUpdate(
    {
      userId,
      guildId,
      tier,
      period,
      quests: questId,
      $expr: { $lt: [{ $add: ["$rerollsUsed", "$skipsUsed"] }, limit] },
    },
    {
      $set: { "quests.$": newQuestId, updatedAt: new Date() },
      $inc: { rerollsUsed: 1 },
    },
    { returnDocument: "after" },
  );
  const after = swap?.value || swap;
  if (!after) return { ok: false, reason: "stale" };

  const cost = rerollCostFor(tier);
  if (cost > 0) {
    const grant = await grantCoins(client, {
      userId,
      guildId,
      username: opts.username,
      avatarHash: opts.avatarHash,
      amount: -cost,
      source: "quest_reroll",
      member: opts.member,
      meta: { tier, from: questId, to: newQuestId, period },
    });
    if (!grant) {
      await client.questAssignmentsCollection
        .updateOne(
          { userId, guildId, tier, period, quests: newQuestId },
          { $set: { "quests.$": questId }, $inc: { rerollsUsed: -1 } },
        )
        .catch(() => {});
      return { ok: false, reason: "charge_failed" };
    }
  }

  return {
    ok: true,
    from: questId,
    to: newQuestId,
    cost,
    used: (after.rerollsUsed || 0) + (after.skipsUsed || 0),
    limit,
  };
}

async function skipQuest(client, userId, guildId, tier, questId, opts = {}) {
  if (!isEnabled()) return { ok: false, reason: "disabled" };
  if (!client.questAssignmentsCollection || !client.questProgressCollection) {
    return { ok: false, reason: "disabled" };
  }

  const assignment = await getOrCreateAssignment(client, userId, guildId, tier);
  if (!assignment) return { ok: false, reason: "no_assignment" };
  if (!assignment.quests?.includes(questId)) return { ok: false, reason: "not_in_pool" };
  if (assignment.skipped?.includes(questId)) return { ok: false, reason: "already_skipped" };

  const period = assignment.period;
  const progress = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (progress?.claimed) return { ok: false, reason: "already_claimed" };

  const limit = actionLimitFor(tier);
  const used = (assignment.rerollsUsed || 0) + (assignment.skipsUsed || 0);
  if (used >= limit) {
    return { ok: false, reason: "over_limit", used, limit };
  }

  const upd = await client.questAssignmentsCollection.findOneAndUpdate(
    {
      userId,
      guildId,
      tier,
      period,
      quests: questId,
      skipped: { $ne: questId },
      $expr: { $lt: [{ $add: ["$rerollsUsed", "$skipsUsed"] }, limit] },
    },
    {
      $addToSet: { skipped: questId },
      $inc: { skipsUsed: 1 },
      $set: { updatedAt: new Date() },
    },
    { returnDocument: "after" },
  );
  const after = upd?.value || upd;
  if (!after) return { ok: false, reason: "stale" };

  const cost = skipCostFor(tier);
  if (cost > 0) {
    const grant = await grantCoins(client, {
      userId,
      guildId,
      username: opts.username,
      avatarHash: opts.avatarHash,
      amount: -cost,
      source: "quest_skip",
      member: opts.member,
      meta: { tier, questId, period },
    });
    if (!grant) {
      await client.questAssignmentsCollection
        .updateOne(
          { userId, guildId, tier, period },
          { $pull: { skipped: questId }, $inc: { skipsUsed: -1 } },
        )
        .catch(() => {});
      return { ok: false, reason: "charge_failed" };
    }
  }

  return {
    ok: true,
    questId,
    cost,
    used: (after.rerollsUsed || 0) + (after.skipsUsed || 0),
    limit,
  };
}

function tierFromPeriod(period) {
  if (period === "weekly") return "weekly";
  if (typeof period === "string" && period.startsWith("evt-")) return null;
  return "daily";
}

module.exports = {
  isEnabled,
  periodFor,
  poolFor,
  poolSizeFor,
  rerollCostFor,
  skipCostFor,
  actionLimitFor,
  getOrCreateAssignment,
  isQuestAssigned,
  rerollQuest,
  skipQuest,
  tierFromPeriod,
};
