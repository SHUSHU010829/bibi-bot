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

// 內部：原子標 claimed + 發幣。成功 → 回傳 { id, name, reward, period }；否則 null
const tryAutoClaim = async (
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
  if (!after) return null; // 已被別的 process 領了，或還沒 completed

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
    // 發放失敗 → rollback claimed
    await client.questProgressCollection
      .updateOne(
        { userId, guildId, questId: questDef.id, period },
        { $set: { claimed: false }, $unset: { claimedAt: "" } }
      )
      .catch(() => {});
    return null;
  }

  return {
    id: questDef.id,
    name: questDef.name,
    reward: grantResult.granted,
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
  const completed = cappedProgress >= target;

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

  let autoClaimed = null;
  if (completed && !doc?.claimed) {
    autoClaimed = await tryAutoClaim(
      client,
      userId,
      guildId,
      quest,
      claimCtx?.member,
      claimCtx?.username
    );
  }

  return { doc, autoClaimed };
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
  const completed = cappedProgress >= target;

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

  let autoClaimed = null;
  if (completed && !doc?.claimed) {
    autoClaimed = await tryAutoClaim(
      client,
      userId,
      guildId,
      quest,
      claimCtx?.member,
      claimCtx?.username
    );
  }

  return { doc, autoClaimed };
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

  let autoClaimed = null;
  if (!doc?.claimed) {
    autoClaimed = await tryAutoClaim(
      client,
      userId,
      guildId,
      quest,
      claimCtx?.member,
      claimCtx?.username
    );
  }

  return { doc, autoClaimed };
};

const getStatus = async (client, userId, guildId) => {
  if (!client.questProgressCollection) {
    return { daily: [], weekly: [], event: [] };
  }
  const dailyDefs = dailyQuests();
  const weeklyDefs = weeklyQuests();
  // 限時活動任務：僅取生效中活動，period token 由定義自帶（`evt-<id>`）。
  const eventDefs = eventQuests();
  const dailyPeriod = periodKey("daily");
  const weeklyPeriod = periodKey("weekly");

  const allIds = [
    ...dailyDefs.map((q) => ({ id: q.id, period: dailyPeriod })),
    ...weeklyDefs.map((q) => ({ id: q.id, period: weeklyPeriod })),
    ...eventDefs.map((q) => ({ id: q.id, period: q.period })),
  ];

  const docs = await client.questProgressCollection
    .find({
      userId,
      guildId,
      $or: allIds.map((x) => ({ questId: x.id, period: x.period })),
    })
    .toArray();

  const byKey = new Map();
  for (const d of docs) byKey.set(`${d.questId}|${d.period}`, d);

  const enrich = (def, period) => {
    const doc = byKey.get(`${def.id}|${period}`);
    const progress = doc?.progress || 0;
    const target = def.target || 1;
    const completed = doc?.completed || progress >= target;
    const claimed = !!doc?.claimed;
    let state = "pending";
    if (claimed) state = "claimed";
    else if (completed) state = "ready";
    else if (progress > 0) state = "in_progress";
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      reward: def.reward,
      target,
      progress: Math.min(progress, target),
      completed,
      claimed,
      state,
      eventName: def.eventName,
    };
  };

  return {
    daily: dailyDefs.map((q) => enrich(q, dailyPeriod)),
    weekly: weeklyDefs.map((q) => enrich(q, weeklyPeriod)),
    event: eventDefs.map((q) => enrich(q, q.period)),
  };
};

// 補領：自動入帳失敗時的退路。掃出 ready 的任務，逐一原子標 claimed + 發幣
const claimAll = async (client, userId, guildId, member, username) => {
  if (!isEnabled()) return { claimed: [], total: 0 };
  if (!client.questProgressCollection) return { claimed: [], total: 0 };

  const status = await getStatus(client, userId, guildId);
  const ready = [
    ...status.daily.map((q) => ({ ...q, period: "daily" })),
    ...status.weekly.map((q) => ({ ...q, period: "weekly" })),
    ...(status.event || []).map((q) => ({ ...q, period: "event" })),
  ].filter((q) => q.state === "ready");

  const claimedList = [];
  let total = 0;
  for (const quest of ready) {
    const questDef = getQuestById(quest.id);
    const result = await tryAutoClaim(
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
  }

  return { claimed: claimedList, total };
};

module.exports = {
  periodKey,
  incrementProgress,
  addMetaValue,
  markCompleted,
  getStatus,
  claimAll,
};
