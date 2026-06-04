require("colors");
const { DateTime } = require("luxon");
const { guildClub } = require("../../config");
const service = require("./guildClubService");

const tz = () => guildClub?.resetTimezone || "Asia/Taipei";

const currentPeriod = () =>
  DateTime.now().setZone(tz()).toFormat("kkkk-'W'WW");

const weekStartDate = () =>
  DateTime.now().setZone(tz()).startOf("week").toJSDate();

const aggregateProgress = async (
  client,
  source,
  memberIds,
  guildId,
  weekStart
) => {
  if (!memberIds.length) return 0;
  if (source === "mineLogs") {
    return client.mineLogsCollection.countDocuments({
      guild_id: guildId,
      user_id: { $in: memberIds },
      ts: { $gte: weekStart },
    });
  }
  if (source === "dungeonLogs") {
    return client.coinTransactionsCollection.countDocuments({
      guildId,
      userId: { $in: memberIds },
      source: "dungeon",
      createdAt: { $gte: weekStart },
    });
  }
  if (source === "casinoLogs") {
    return client.coinTransactionsCollection.countDocuments({
      guildId,
      userId: { $in: memberIds },
      source: "bet",
      createdAt: { $gte: weekStart },
    });
  }
  return 0;
};

const getQuestStatus = async (client, { userId, guildId }) => {
  const m = await service.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  let club = await service.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };
  club = await service.settleLockedTreasury(client, club);

  const members = await service.listMembers(client, club.guild_club_id);
  const memberIds = members.map((x) => x.userId);
  const weekStart = weekStartDate();
  const period = currentPeriod();

  const quests = guildClub?.weeklyQuests || [];
  const claims = await client.guildClubQuestClaimsCollection
    .find({ guild_club_id: club.guild_club_id, period })
    .toArray();
  const claimedSet = new Set(claims.map((c) => c.questId));

  const items = await Promise.all(
    quests.map(async (q) => {
      const progress = await aggregateProgress(
        client,
        q.source,
        memberIds,
        guildId,
        weekStart
      );
      const claimed = claimedSet.has(q.id);
      const completed = progress >= q.target;
      return {
        ...q,
        progress: Math.min(progress, q.target),
        rawProgress: progress,
        completed,
        claimed,
        state: claimed ? "claimed" : completed ? "ready" : "in_progress",
      };
    })
  );

  return {
    ok: true,
    club,
    membership: m,
    isLeader: m.role === "leader" || m.role === "vice_leader",
    role: m.role,
    period,
    weekStart,
    memberCount: memberIds.length,
    items,
  };
};

const claimAllReady = async (client, { userId, guildId }) => {
  const status = await getQuestStatus(client, { userId, guildId });
  if (!status.ok) return status;
  if (!status.isLeader) return { ok: false, reason: "not_leader" };

  const ready = status.items.filter((i) => i.state === "ready");
  if (ready.length === 0)
    return { ok: false, reason: "nothing_to_claim", items: status.items };

  const period = status.period;
  const now = new Date();
  const claimed = [];

  for (const q of ready) {
    try {
      await client.guildClubQuestClaimsCollection.insertOne({
        guild_club_id: status.club.guild_club_id,
        questId: q.id,
        period,
        claimedAt: now,
        amount: q.reward,
      });
      claimed.push(q);
    } catch (e) {
      if (e?.code === 11000) continue;
      console.log(`[GUILD_QUEST] claim insert error: ${e.message}`.red);
    }
  }

  if (claimed.length === 0)
    return { ok: false, reason: "all_claimed_by_other" };

  // 任務獎勵進「鎖定金庫」：累積（升級判定）馬上入帳，但解散可分配池要等
  // questRewardLockHours 後才解鎖，避免任務金被即時 disband 洗走。
  const totalReward = claimed.reduce((s, q) => s + q.reward, 0);
  const lockMs = service.hoursToMs(
    service.antiLaunderingCfg().questRewardLockHours
  );
  const unlocksAt = new Date(now.getTime() + (lockMs || 0));
  const lockEntry = {
    amount: totalReward,
    unlocksAt,
    source: "quest_reward",
    period,
    questIds: claimed.map((q) => q.id),
  };

  const updated = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: status.club.guild_club_id, disbanded_at: null },
    {
      $inc: { treasury: totalReward, treasury_locked: totalReward },
      $push: { locked_entries: lockEntry },
      $set: { updated_at: now },
    },
    { returnDocument: "after" }
  );
  const updatedDoc = updated?.value || updated;

  await client.guildClubLogsCollection.insertOne({
    guild_club_id: status.club.guild_club_id,
    user_id: null,
    amount: totalReward,
    source: "quest_reward",
    meta: {
      questIds: claimed.map((q) => q.id),
      period,
      unlocksAt,
      lockHours: service.antiLaunderingCfg().questRewardLockHours || 0,
    },
    createdAt: now,
  });

  let levelUp = null;
  if (updatedDoc) {
    const oldTreasury = (updatedDoc.treasury || 0) - totalReward;
    const oldLevel = updatedDoc.level;
    const crossedThresholds = guildClub.levels.filter(
      (l) =>
        l.level > oldLevel &&
        l.threshold > oldTreasury &&
        l.threshold <= (updatedDoc.treasury || 0)
    ).length;
    levelUp = await service.checkLevelUp(client, updatedDoc, {
      crossedThresholds,
    });
  }

  return {
    ok: true,
    club: levelUp?.club || updatedDoc || status.club,
    claimed,
    totalReward,
    levelUp,
  };
};

const getLeaderboard = async (client, { guildId, limit = 10 }) => {
  const clubs = await client.guildsClubCollection
    .find({ guildId, disbanded_at: null })
    .sort({ treasury: -1, created_at: 1 })
    .limit(limit)
    .toArray();
  const enriched = await Promise.all(
    clubs.map(async (c) => {
      const count = await client.guildClubMembersCollection.countDocuments({
        guild_club_id: c.guild_club_id,
      });
      return { ...c, member_count: count };
    })
  );
  return enriched;
};

module.exports = {
  currentPeriod,
  weekStartDate,
  aggregateProgress,
  getQuestStatus,
  claimAllReady,
  getLeaderboard,
};
