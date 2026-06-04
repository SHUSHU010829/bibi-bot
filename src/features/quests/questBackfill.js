// 任務指派 / 重抽時，從現有活動 log 回填當期 (daily / weekly) 進度。
//
// 為什麼需要：新個人化指派系統上線時（或玩家用重抽抽到新任務時），
// 進度條從 0 開始；但玩家當期可能已經做過相關活動，那段活動本來該算數。
// 這個模組會在「指派產生／重抽完成」當下，從各種 log 撈當期累積值寫回 QuestProgress。
//
// 不是所有任務都能回填（地下城、合成、人氣、農場目前沒有可查的 log），
// 對應 questId 不在 BACKFILL_MAP 裡 → 就跳過、維持 0。

require("colors");
const { DateTime } = require("luxon");

const { questSystem } = require("../../config");
const { getQuestById } = require("./questDefinitions");

const TZ = () => questSystem?.resetTimezone || "Asia/Taipei";

function todayDateKey() {
  return DateTime.now().setZone(TZ()).toISODate();
}

function weekDateKeys() {
  const now = DateTime.now().setZone(TZ());
  const weekStart = now.startOf("week"); // luxon: 週一
  const out = [];
  for (let i = 0; i < 7; i += 1) out.push(weekStart.plus({ days: i }).toISODate());
  return out;
}

function weekTsRange() {
  const now = DateTime.now().setZone(TZ());
  return {
    start: now.startOf("week").toJSDate(),
    end: now.endOf("week").toJSDate(),
  };
}

function todayTsRange() {
  const now = DateTime.now().setZone(TZ());
  return {
    start: now.startOf("day").toJSDate(),
    end: now.endOf("day").toJSDate(),
  };
}

const RARE_ORES = new Set(["iron", "gold", "diamond"]);

// 各任務的回填函式：回傳 { progress, meta? } 或 null（無法回填則 null）
const BACKFILL_MAP = {
  // ── 訊息 ─────────────────────────────────────────────
  daily_messages: async (client, userId, guildId) => {
    if (!client.messageStatsCollection) return null;
    const rows = await client.messageStatsCollection
      .find({ userId, guildId, date: todayDateKey() })
      .toArray()
      .catch(() => []);
    const total = rows.reduce((s, r) => s + (r.messageCount || 0), 0);
    return { progress: total };
  },
  weekly_messages: async (client, userId, guildId) => {
    if (!client.messageStatsCollection) return null;
    const rows = await client.messageStatsCollection
      .find({ userId, guildId, date: { $in: weekDateKeys() } })
      .toArray()
      .catch(() => []);
    const total = rows.reduce((s, r) => s + (r.messageCount || 0), 0);
    return { progress: total };
  },

  // ── 語音（VoiceStats 是「每段 session 一筆」，含 durationMinutes）──
  daily_voice_30: async (client, userId, guildId) => {
    if (!client.voiceStatsCollection) return null;
    const rows = await client.voiceStatsCollection
      .find({ userId, guildId, date: todayDateKey() })
      .toArray()
      .catch(() => []);
    const mins = rows.reduce((s, r) => s + (r.durationMinutes || 0), 0);
    return { progress: mins };
  },
  daily_voice_60: async (client, userId, guildId) => {
    if (!client.voiceStatsCollection) return null;
    const rows = await client.voiceStatsCollection
      .find({ userId, guildId, date: todayDateKey() })
      .toArray()
      .catch(() => []);
    const mins = rows.reduce((s, r) => s + (r.durationMinutes || 0), 0);
    return { progress: mins };
  },

  // ── 挖礦（MineLogs 用 user_id / guild_id / ore / ts）────────────────
  daily_mine_3: async (client, userId, guildId) => {
    if (!client.mineLogsCollection) return null;
    const { start, end } = todayTsRange();
    const n = await client.mineLogsCollection
      .countDocuments({ user_id: userId, guild_id: guildId, ts: { $gte: start, $lte: end } })
      .catch(() => 0);
    return { progress: n };
  },
  weekly_mine_20: async (client, userId, guildId) => {
    if (!client.mineLogsCollection) return null;
    const { start, end } = weekTsRange();
    const n = await client.mineLogsCollection
      .countDocuments({ user_id: userId, guild_id: guildId, ts: { $gte: start, $lte: end } })
      .catch(() => 0);
    return { progress: n };
  },
  daily_rare_ore: async (client, userId, guildId) => {
    if (!client.mineLogsCollection) return null;
    const { start, end } = todayTsRange();
    const n = await client.mineLogsCollection
      .countDocuments({
        user_id: userId,
        guild_id: guildId,
        ore: { $in: Array.from(RARE_ORES) },
        ts: { $gte: start, $lte: end },
      })
      .catch(() => 0);
    return { progress: n };
  },
  weekly_diamond: async (client, userId, guildId) => {
    if (!client.mineLogsCollection) return null;
    const { start, end } = weekTsRange();
    const n = await client.mineLogsCollection
      .countDocuments({
        user_id: userId,
        guild_id: guildId,
        ore: "diamond",
        ts: { $gte: start, $lte: end },
      })
      .catch(() => 0);
    return { progress: n };
  },

  // ── 賣礦（CoinTransactions source=mining_sell）────────────
  daily_sell_ore: async (client, userId, guildId) => {
    if (!client.coinTransactionsCollection) return null;
    const n = await client.coinTransactionsCollection
      .countDocuments({ userId, guildId, source: "mining_sell", date: todayDateKey() })
      .catch(() => 0);
    return { progress: n };
  },
  weekly_sell_value: async (client, userId, guildId) => {
    if (!client.coinTransactionsCollection) return null;
    const cursor = client.coinTransactionsCollection.aggregate([
      {
        $match: {
          userId,
          guildId,
          source: "mining_sell",
          date: { $in: weekDateKeys() },
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const rows = await cursor.toArray().catch(() => []);
    const total = rows[0]?.total || 0;
    return { progress: total, meta: { sellValue: total } };
  },

  // ── 打工 / 賭博 / 股票（皆走 CoinTransactions source 篩選）────
  daily_work: async (client, userId, guildId) => {
    if (!client.coinTransactionsCollection) return null;
    const n = await client.coinTransactionsCollection
      .countDocuments({ userId, guildId, source: "work", date: todayDateKey() })
      .catch(() => 0);
    return { progress: n };
  },
  daily_gamble: async (client, userId, guildId) => {
    if (!client.coinTransactionsCollection) return null;
    const n = await client.coinTransactionsCollection
      .countDocuments({ userId, guildId, source: "bet", date: todayDateKey() })
      .catch(() => 0);
    return { progress: Math.min(n, 1) };
  },
  daily_stock: async (client, userId, guildId) => {
    if (!client.stockTransactionsCollection) return null;
    const { start, end } = todayTsRange();
    const n = await client.stockTransactionsCollection
      .countDocuments({ userId, guildId, timestamp: { $gte: start, $lte: end } })
      .catch(() => 0);
    return { progress: Math.min(n, 1) };
  },

  // ── 簽到（DailyCheckin 每天一筆）─────────────────────
  weekly_attendance: async (client, userId, guildId) => {
    if (!client.dailyCheckinCollection) return null;
    const n = await client.dailyCheckinCollection
      .countDocuments({ userId, guildId, date: { $in: weekDateKeys() } })
      .catch(() => 0);
    return { progress: n };
  },
};

function periodKeyFor(period) {
  if (period === "weekly") {
    return DateTime.now().setZone(TZ()).toFormat("kkkk-'W'WW");
  }
  return DateTime.now().setZone(TZ()).toISODate();
}

// 主要入口：對一個 quest 跑回填。
// 規則：
//   - 已 claimed → 完全不動（保留領取紀錄）
//   - 否則：progress = max(existing.progress, backfilled)
//           completed = existing.completed || newProgress >= target
//   - 沒有對應 BACKFILL_MAP → 直接 noop
module.exports = async function backfillQuestProgress(client, userId, guildId, questId) {
  if (!client?.questProgressCollection) return;
  const fn = BACKFILL_MAP[questId];
  if (!fn) return;
  const def = getQuestById(questId);
  if (!def) return;

  let result = null;
  try {
    result = await fn(client, userId, guildId);
  } catch (e) {
    console.log(`[WARN] quest backfill ${questId} failed: ${e?.message || e}`.yellow);
    return;
  }
  if (!result) return;

  const period = periodKeyFor(def.period);
  const target = def.target || 1;
  const backfilled = Math.max(0, Math.floor(result.progress || 0));

  const existing = await client.questProgressCollection
    .findOne({ userId, guildId, questId, period })
    .catch(() => null);

  if (existing?.claimed) return;

  const existingProgress = existing?.progress || 0;
  const newProgress = Math.min(target, Math.max(existingProgress, backfilled));
  const completed = !!existing?.completed || newProgress >= target;

  // 沒進步 → 不寫
  if (existing && newProgress === existingProgress && completed === !!existing.completed) {
    return;
  }

  const set = {
    progress: newProgress,
    completed,
    updatedAt: new Date(),
  };
  if (result.meta) {
    for (const [k, v] of Object.entries(result.meta)) {
      set[`meta.${k}`] = Math.max(existing?.meta?.[k] || 0, v);
    }
  }

  await client.questProgressCollection
    .updateOne(
      { userId, guildId, questId, period },
      {
        $set: set,
        $setOnInsert: {
          userId,
          guildId,
          questId,
          period,
          claimed: false,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    )
    .catch((e) => console.log(`[WARN] backfill upsert ${questId}: ${e?.message || e}`.yellow));
};
