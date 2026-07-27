require("colors");
const { DateTime } = require("luxon");
const { questSystem } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const {
  getQuestById,
  dailyQuests,
  weeklyQuests,
  eventQuests,
  isEnabled,
} = require("./questDefinitions");
const questAssignmentService = require("./questAssignmentService");
const questRewards = require("./questRewards");
const notifyQuestReady = require("./notifyQuestReady");

// 進度更新後判定「剛從未達標 → 達標」就觸發通知（非阻塞）。
function fireReadyNotifyIfFlipped(client, quest, existing, doc, claimCtx) {
  if (!doc?.completed) return;
  if (existing?.completed) return;
  if (doc?.claimed) return;
  const ctx = {
    userId: doc.userId,
    guildId: doc.guildId,
    user: claimCtx?.member?.user || null,
    interaction: claimCtx?.interaction || null,
  };
  notifyQuestReady(client, ctx, {
    id: quest.id,
    name: quest.name,
    reward: quest.reward,
    rewardItems: quest.rewardItems || null,
    period: quest.period,
  }).catch(() => {});
}

const getTz = () => questSystem?.resetTimezone || "Asia/Taipei";

const isEventPeriod = (period) =>
  typeof period === "string" && period.startsWith("evt-");

const periodKey = (period, tz = getTz()) => {
  if (period === "weekly") {
    // ISO 週：YYYY-Www（例：2026-W19）
    return DateTime.now().setZone(tz).toFormat("kkkk-'W'WW");
  }
  // 限時活動任務：period 本身即週期 token（`evt-<id>`），以活動實例為界。
  if (isEventPeriod(period)) return period;
  return DateTime.now().setZone(tz).toISODate(); // daily → YYYY-MM-DD
};

const grantSourceFor = (period) => {
  if (period === "weekly") return "quest_weekly";
  if (isEventPeriod(period)) return "quest_event";
  return "quest_daily";
};

// ── 任務里程碑：完成 N 個當期任務額外送 CD 券（每期每個里程碑只發一次）──
const milestonesFor = (tier) => {
  const list = questSystem?.milestones?.[tier];
  return Array.isArray(list) ? list : [];
};

const tierQuestIds = (tier) =>
  (tier === "weekly" ? weeklyQuests() : dailyQuests()).map((q) => q.id);

// 當期（daily/weekly）已領取的任務數（只算正式任務，里程碑 doc 不在 tierQuestIds 內）。
const countClaimedQuests = async (client, userId, guildId, tier) => {
  const ids = tierQuestIds(tier);
  if (!ids.length) return 0;
  const period = periodKey(tier);
  return client.questProgressCollection
    .countDocuments({ userId, guildId, period, claimed: true, questId: { $in: ids } })
    .catch(() => 0);
};

// 檢查並發放本次新達成的里程碑。回傳 [{ id, name, count, rewardItems, grantedItems, tier }]。
const grantTierMilestones = async (client, userId, guildId, tier) => {
  const milestones = milestonesFor(tier);
  if (!milestones.length) return [];
  const claimedCount = await countClaimedQuests(client, userId, guildId, tier);
  const period = periodKey(tier);
  const out = [];
  for (const ms of milestones) {
    if (claimedCount < ms.count) continue;
    const existing = await client.questProgressCollection
      .findOne({ userId, guildId, questId: ms.id, period })
      .catch(() => null);
    if (existing?.claimed) continue;

    let after = null;
    try {
      const upd = await client.questProgressCollection.findOneAndUpdate(
        { userId, guildId, questId: ms.id, period, claimed: { $ne: true } },
        {
          $set: {
            claimed: true,
            claimedAt: new Date(),
            milestone: true,
            completed: true,
            progress: ms.count,
            updatedAt: new Date(),
          },
          $setOnInsert: { userId, guildId, questId: ms.id, period, createdAt: new Date() },
        },
        { upsert: true, returnDocument: "after" }
      );
      after = upd?.value || upd;
    } catch (e) {
      // 併發：另一路徑已搶先標記 → upsert 撞 unique index，視為已領略過
      continue;
    }
    if (!after) continue;

    let grantedItems = [];
    try {
      grantedItems = await questRewards.grantQuestItems(
        client,
        userId,
        guildId,
        ms.rewardItems
      );
    } catch (e) {
      console.log(`[QUEST] grant milestone items ${ms.id} for ${userId}: ${e}`.red);
      await client.questProgressCollection
        .updateOne(
          { userId, guildId, questId: ms.id, period },
          { $set: { claimed: false }, $unset: { claimedAt: "" } }
        )
        .catch(() => {});
      continue;
    }
    out.push({
      id: ms.id,
      name: ms.name,
      count: ms.count,
      rewardItems: ms.rewardItems || null,
      grantedItems,
      tier,
    });
  }
  return out;
};

// 原子標 claimed + 發幣。成功 → { id, name, reward, period }；已 claimed → null
const tryClaimOne = async (
  client,
  userId,
  guildId,
  questDef,
  member,
  username
) => {
  if (!questDef) return null;
  const period = periodKey(questDef.period);

  const update = await client.questProgressCollection.findOneAndUpdate(
    {
      userId,
      guildId,
      questId: questDef.id,
      period,
      completed: true,
      claimed: { $ne: true },
    },
    {
      $set: {
        claimed: true,
        claimedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  const after = update?.value || update;
  if (!after) return null;

  const rollbackClaim = () =>
    client.questProgressCollection
      .updateOne(
        { userId, guildId, questId: questDef.id, period },
        { $set: { claimed: false }, $unset: { claimedAt: "" } }
      )
      .catch(() => {});

  let granted = 0;
  if (questDef.reward > 0) {
    const grantResult = await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: questDef.reward,
      source: grantSourceFor(questDef.period),
      member,
      meta: { questId: questDef.id, period },
    });
    if (!grantResult) {
      await rollbackClaim();
      return null;
    }
    granted = grantResult.granted;
  }

  // 道具獎勵（如 CD 縮短券）：發到 miningProfiles。純道具任務若發放失敗就還原
  // claimed 讓玩家可重領；已入帳金幣的任務則只記 log（金幣無法回滾）。
  let grantedItems = [];
  if (questRewards.hasItemRewards(questDef.rewardItems)) {
    try {
      grantedItems = await questRewards.grantQuestItems(
        client,
        userId,
        guildId,
        questDef.rewardItems
      );
    } catch (e) {
      console.log(`[QUEST] grant items ${questDef.id} for ${userId}: ${e}`.red);
      if (questDef.reward > 0) return null;
      await rollbackClaim();
      return null;
    }
  }

  return {
    id: questDef.id,
    name: questDef.name,
    reward: granted,
    rewardItems: questDef.rewardItems || null,
    grantedItems,
    period: questDef.period,
  };
};

const incrementProgress = async (
  client,
  userId,
  guildId,
  questId,
  delta = 1,
  claimCtx = null
) => {
  if (!isEnabled()) return null;
  if (!client.questProgressCollection) return null;
  const quest = getQuestById(questId);
  if (!quest) return null;
  const period = periodKey(quest.period);
  const target = quest.target || 1;

  const tier = questAssignmentService.tierFromPeriod(quest.period);
  if (tier && !(await questAssignmentService.isQuestAssigned(client, userId, guildId, tier, questId))) {
    return null;
  }

  // 先讀現值決定是否要標 completed（用 update + filter 避免重置已 claimed 的紀錄）
  const existing = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (existing?.claimed) {
    return { doc: existing, autoClaimed: null };
  }

  // 把進度直接 cap 在 target 上（不需要追蹤超過部分）
  const cappedProgress = Math.min(target, (existing?.progress || 0) + delta);
  // 一旦達標就永遠保持 completed（避免目標值之後被上調時把已完成翻回未完成）
  const completed = !!existing?.completed || cappedProgress >= target;

  const update = await client.questProgressCollection.findOneAndUpdate(
    { userId, guildId, questId, period },
    {
      $set: {
        progress: cappedProgress,
        completed,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        userId,
        guildId,
        questId,
        period,
        claimed: false,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  const doc = update?.value || update;
  fireReadyNotifyIfFlipped(client, quest, existing, doc, claimCtx);

  return { doc, autoClaimed: null };
};

// 累計型任務：把 delta 累加到 meta[key]，並以累計值對比 target 判定完成。
// 用於「金額」「分鐘數」等非次數型條件（例：weekly_sell_value 累計賣礦收入）。
const addMetaValue = async (
  client,
  userId,
  guildId,
  questId,
  key,
  delta = 0,
  claimCtx = null
) => {
  if (!isEnabled()) return null;
  if (!client.questProgressCollection) return null;
  if (!key || !(delta > 0)) return null;
  const quest = getQuestById(questId);
  if (!quest) return null;
  const period = periodKey(quest.period);
  const target = quest.target || 1;

  const tier = questAssignmentService.tierFromPeriod(quest.period);
  if (tier && !(await questAssignmentService.isQuestAssigned(client, userId, guildId, tier, questId))) {
    return null;
  }

  const existing = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (existing?.claimed) {
    return { doc: existing, autoClaimed: null };
  }

  const newMetaVal = (existing?.meta?.[key] || 0) + delta;
  const cappedProgress = Math.min(target, newMetaVal);
  // 同 incrementProgress：completed 是單調的，避免事後上調 target 把達標翻回未達標
  const completed = !!existing?.completed || cappedProgress >= target;

  const update = await client.questProgressCollection.findOneAndUpdate(
    { userId, guildId, questId, period },
    {
      $set: {
        [`meta.${key}`]: newMetaVal,
        progress: cappedProgress,
        completed,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        userId,
        guildId,
        questId,
        period,
        claimed: false,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  const doc = update?.value || update;
  fireReadyNotifyIfFlipped(client, quest, existing, doc, claimCtx);

  return { doc, autoClaimed: null };
};

const markCompleted = async (
  client,
  userId,
  guildId,
  questId,
  claimCtx = null
) => {
  if (!isEnabled()) return null;
  if (!client.questProgressCollection) return null;
  const quest = getQuestById(questId);
  if (!quest) return null;
  const period = periodKey(quest.period);
  const target = quest.target || 1;

  const tier = questAssignmentService.tierFromPeriod(quest.period);
  if (tier && !(await questAssignmentService.isQuestAssigned(client, userId, guildId, tier, questId))) {
    return null;
  }

  // 已領取 → 直接回傳，避免 upsert 撞 unique index (E11000)
  const existing = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (existing?.claimed) {
    return { doc: existing, autoClaimed: null };
  }

  const update = await client.questProgressCollection.findOneAndUpdate(
    { userId, guildId, questId, period },
    {
      $set: {
        progress: target,
        completed: true,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        userId,
        guildId,
        questId,
        period,
        claimed: false,
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  const doc = update?.value || update;
  fireReadyNotifyIfFlipped(client, quest, existing, doc, claimCtx);

  return { doc, autoClaimed: null };
};

const getStatus = async (client, userId, guildId) => {
  if (!client.questProgressCollection) {
    return { daily: [], weekly: [], event: [], assignment: null };
  }
  const dailyDefsAll = dailyQuests();
  const weeklyDefsAll = weeklyQuests();
  // 限時活動任務：僅取生效中活動，period token 由定義自帶（`evt-<id>`）。
  const eventDefs = eventQuests();
  const dailyPeriod = periodKey("daily");
  const weeklyPeriod = periodKey("weekly");

  let dailyAssignment = null;
  let weeklyAssignment = null;
  if (questAssignmentService.isEnabled()) {
    [dailyAssignment, weeklyAssignment] = await Promise.all([
      questAssignmentService.getOrCreateAssignment(client, userId, guildId, "daily"),
      questAssignmentService.getOrCreateAssignment(client, userId, guildId, "weekly"),
    ]);
  }

  const filterByAssignment = (defs, assignment) => {
    if (!assignment) return defs;
    const order = assignment.quests || [];
    const skipped = new Set(assignment.skipped || []);
    const byId = new Map(defs.map((q) => [q.id, q]));
    return order
      .filter((id) => byId.has(id) && !skipped.has(id))
      .map((id) => byId.get(id));
  };

  const dailyDefs = filterByAssignment(dailyDefsAll, dailyAssignment);
  const weeklyDefs = filterByAssignment(weeklyDefsAll, weeklyAssignment);

  const allIds = [
    ...dailyDefs.map((q) => ({ id: q.id, period: dailyPeriod })),
    ...weeklyDefs.map((q) => ({ id: q.id, period: weeklyPeriod })),
    ...eventDefs.map((q) => ({ id: q.id, period: q.period })),
  ];

  const docs = allIds.length
    ? await client.questProgressCollection
        .find({
          userId,
          guildId,
          $or: allIds.map((x) => ({ questId: x.id, period: x.period })),
        })
        .toArray()
    : [];

  const byKey = new Map();
  for (const d of docs) byKey.set(`${d.questId}|${d.period}`, d);

  const enrich = (def, period) => {
    const doc = byKey.get(`${def.id}|${period}`);
    const rawProgress = doc?.progress || 0;
    const target = def.target || 1;
    const completed = doc?.completed || rawProgress >= target;
    const claimed = !!doc?.claimed;
    let state = "pending";
    if (claimed) state = "claimed";
    else if (completed) state = "ready";
    else if (rawProgress > 0) state = "in_progress";
    // 已完成就顯示滿條（避免事後上調 target 時，已達標玩家看到「9 / 20」這種卡住的條）
    const displayProgress = completed ? target : Math.min(rawProgress, target);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      reward: def.reward,
      rewardItems: def.rewardItems || null,
      target,
      progress: displayProgress,
      completed,
      claimed,
      state,
      eventName: def.eventName,
    };
  };

  const dailyRows = dailyDefs.map((q) => enrich(q, dailyPeriod));
  const weeklyRows = weeklyDefs.map((q) => enrich(q, weeklyPeriod));

  // 里程碑狀態（供面板顯示「完成 N 個任務再拿 CD 券」）。
  const msSpecs = [
    ...milestonesFor("daily").map((m) => ({
      ...m,
      tier: "daily",
      period: dailyPeriod,
      claimedCount: dailyRows.filter((q) => q.state === "claimed").length,
    })),
    ...milestonesFor("weekly").map((m) => ({
      ...m,
      tier: "weekly",
      period: weeklyPeriod,
      claimedCount: weeklyRows.filter((q) => q.state === "claimed").length,
    })),
  ];
  let msDocs = [];
  if (msSpecs.length) {
    msDocs = await client.questProgressCollection
      .find({
        userId,
        guildId,
        $or: msSpecs.map((m) => ({ questId: m.id, period: m.period })),
      })
      .toArray()
      .catch(() => []);
  }
  const msClaimed = new Set(
    msDocs.filter((d) => d.claimed).map((d) => `${d.questId}|${d.period}`)
  );
  const milestoneRow = (m) => ({
    id: m.id,
    name: m.name,
    count: m.count,
    rewardItems: m.rewardItems || null,
    tier: m.tier,
    claimedCount: m.claimedCount,
    reached: m.claimedCount >= m.count,
    claimed: msClaimed.has(`${m.id}|${m.period}`),
  });

  return {
    daily: dailyRows,
    weekly: weeklyRows,
    event: eventDefs.map((q) => enrich(q, q.period)),
    assignment: {
      daily: dailyAssignment,
      weekly: weeklyAssignment,
    },
    milestones: {
      daily: msSpecs.filter((m) => m.tier === "daily").map(milestoneRow),
      weekly: msSpecs.filter((m) => m.tier === "weekly").map(milestoneRow),
    },
  };
};

// 領取單個 ready 任務（玩家點按鈕觸發）
const claimSingle = async (client, userId, guildId, questId, member, username) => {
  if (!isEnabled()) return { ok: false, reason: "disabled" };
  if (!client.questProgressCollection) return { ok: false, reason: "disabled" };

  const def = getQuestById(questId);
  if (!def) return { ok: false, reason: "not_found" };

  const period = periodKey(def.period);
  const existing = await client.questProgressCollection.findOne({
    userId,
    guildId,
    questId,
    period,
  });
  if (!existing || !existing.completed) return { ok: false, reason: "not_ready" };
  if (existing.claimed) return { ok: false, reason: "already_claimed" };

  const result = await tryClaimOne(client, userId, guildId, def, member, username);
  if (!result) return { ok: false, reason: "stale" };

  const tier = questAssignmentService.tierFromPeriod(def.period);
  const milestones = tier
    ? await grantTierMilestones(client, userId, guildId, tier).catch(() => [])
    : [];
  return { ok: true, claimed: result, milestones };
};

// 一鍵領取：掃出 ready 的任務，依「獎勵高 → 低」順序逐一領取
const claimAll = async (client, userId, guildId, member, username) => {
  if (!isEnabled()) return { claimed: [], total: 0 };
  if (!client.questProgressCollection) return { claimed: [], total: 0 };

  const status = await getStatus(client, userId, guildId);
  const ready = [
    ...status.daily.map((q) => ({ ...q, period: "daily" })),
    ...status.weekly.map((q) => ({ ...q, period: "weekly" })),
    ...(status.event || []).map((q) => ({ ...q, period: "event" })),
  ]
    .filter((q) => q.state === "ready")
    .sort((a, b) => (b.reward || 0) - (a.reward || 0));

  const claimedList = [];
  const itemTotals = {};
  let total = 0;
  for (const quest of ready) {
    const questDef = getQuestById(quest.id);
    const result = await tryClaimOne(
      client,
      userId,
      guildId,
      questDef,
      member,
      username
    );
    if (!result) continue;
    claimedList.push(result);
    total += result.reward;
    for (const { key, qty } of result.grantedItems || []) {
      itemTotals[key] = (itemTotals[key] || 0) + qty;
    }
  }

  // 領完後結算里程碑（完成 N 個任務額外送 CD 券），把獎勵併進 itemTotals。
  const milestones = [];
  if (claimedList.length > 0) {
    for (const tier of ["daily", "weekly"]) {
      const reached = await grantTierMilestones(client, userId, guildId, tier).catch(
        () => []
      );
      for (const ms of reached) {
        milestones.push(ms);
        for (const { key, qty } of ms.grantedItems || []) {
          itemTotals[key] = (itemTotals[key] || 0) + qty;
        }
      }
    }
  }

  return { claimed: claimedList, total, itemTotals, milestones };
};

// 每日 23:50 cron 用：掃出所有「completed=true, claimed=false」的玩家，逐一 claimAll
// 把忘了領的當期任務全部結算入帳，避免跨期作廢。
const autoFlushAllReady = async (client) => {
  if (!isEnabled()) return { users: 0, total: 0 };
  if (!client.questProgressCollection) return { users: 0, total: 0 };

  const rows = await client.questProgressCollection
    .aggregate([
      { $match: { completed: true, claimed: { $ne: true } } },
      { $group: { _id: { userId: "$userId", guildId: "$guildId" } } },
    ])
    .toArray();

  let users = 0;
  let total = 0;
  for (const r of rows) {
    const { userId, guildId } = r._id;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const member = await guild.members.fetch(userId).catch(() => null);
    const username = member?.user?.username || null;
    const res = await module.exports
      .claimAll(client, userId, guildId, member, username)
      .catch((e) => {
        console.log(`[QUEST] autoFlush user ${userId}: ${e}`.red);
        return null;
      });
    if (res?.claimed?.length > 0) {
      users += 1;
      total += res.total || 0;
    }
  }
  return { users, total };
};

module.exports = {
  periodKey,
  incrementProgress,
  addMetaValue,
  markCompleted,
  getStatus,
  claimSingle,
  claimAll,
  autoFlushAllReady,
};
