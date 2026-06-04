require("colors");
const { DateTime } = require("luxon");
const { coinSystem } = require("../../config");

const CHAT_SOURCES = ["message", "voice", "reaction"];

function cfg() {
  return coinSystem?.chatBuffer || {};
}

function todayIso() {
  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  return DateTime.now().setZone(tz).toISODate();
}

function flushThreshold() {
  return Math.max(1, cfg().flushThreshold ?? 50);
}

// 計算指定 source 已 flush 進 CoinTransactions 的今日金額（cap 檢查用）
async function getTodayFlushed(client, userId, guildId, sources) {
  if (!client.coinTransactionsCollection) return 0;
  const agg = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          userId,
          guildId,
          source: { $in: sources },
          date: todayIso(),
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ])
    .toArray();
  return agg[0]?.total || 0;
}

function getCapInfoForSource(source) {
  if (source === "reaction") {
    return {
      cap: coinSystem?.reaction?.dailyCapPerUser ?? 10,
      sources: ["reaction"],
    };
  }
  return {
    cap: coinSystem?.messageVoiceDailyCap ?? 200,
    sources: ["message", "voice"],
  };
}

// 把聊天/語音/表情金幣 inc 到 buffer，回傳實際入帳金額（已套用每日上限）
async function addToBuffer(client, opts) {
  if (!client.userCoinsCollection) return null;
  if (!CHAT_SOURCES.includes(opts.source)) return null;

  const requested = Math.floor(opts.amount || 0);
  if (requested <= 0) return null;

  const { cap, sources } = getCapInfoForSource(opts.source);

  const userDoc = await client.userCoinsCollection.findOne(
    { userId: opts.userId, guildId: opts.guildId },
    { projection: { chatBuffer: 1 } },
  );
  const pendingInCap = sources.reduce(
    (s, src) => s + (userDoc?.chatBuffer?.pending?.[src] || 0),
    0,
  );
  const earnedToday = await getTodayFlushed(client, opts.userId, opts.guildId, sources);
  const remainCap = cap - earnedToday - pendingInCap;
  if (remainCap <= 0) return null;

  const grantAmount = Math.min(requested, remainCap);
  if (grantAmount <= 0) return null;

  const now = new Date();
  const set = {
    updatedAt: now,
    [`chatBuffer.lastAt.${opts.source}`]: now,
  };
  if (opts.username !== undefined) set.username = opts.username;
  if (opts.avatarHash !== undefined) set.avatarHash = opts.avatarHash;

  const inc = { [`chatBuffer.pending.${opts.source}`]: grantAmount };

  const result = await client.userCoinsCollection.findOneAndUpdate(
    { userId: opts.userId, guildId: opts.guildId },
    {
      $inc: inc,
      $set: set,
      $setOnInsert: {
        userId: opts.userId,
        guildId: opts.guildId,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  const updated = result.value || result;

  const pendingAll = CHAT_SOURCES.reduce(
    (s, src) => s + (updated?.chatBuffer?.pending?.[src] || 0),
    0,
  );
  if (pendingAll >= flushThreshold()) {
    flushUserBuffer(client, opts.userId, opts.guildId, { reason: "threshold" }).catch(
      (e) => console.log(`[CHAT-BUFFER] flush on threshold: ${e}`.red),
    );
  }

  return {
    granted: grantAmount,
    buffered: true,
    pending: pendingAll,
    doc: updated,
  };
}

// 原子地把指定玩家的 buffer 歸零，並把累積金額寫入 CoinTransactions / totalCoins。
// 同一玩家併發呼叫只有一次會真正寫入。
async function flushUserBuffer(client, userId, guildId, opts = {}) {
  if (!client.userCoinsCollection || !client.coinTransactionsCollection) return null;

  const claim = await client.userCoinsCollection.findOneAndUpdate(
    {
      userId,
      guildId,
      $or: CHAT_SOURCES.map((s) => ({
        [`chatBuffer.pending.${s}`]: { $gt: 0 },
      })),
    },
    {
      $set: {
        "chatBuffer.pending.message": 0,
        "chatBuffer.pending.voice": 0,
        "chatBuffer.pending.reaction": 0,
        "chatBuffer.lastFlushAt": new Date(),
        updatedAt: new Date(),
      },
    },
    { returnDocument: "before" },
  );
  const before = claim.value || claim;
  if (!before) return null;

  const claimed = {};
  let totalAmount = 0;
  for (const src of CHAT_SOURCES) {
    const amt = before.chatBuffer?.pending?.[src] || 0;
    if (amt > 0) {
      claimed[src] = amt;
      totalAmount += amt;
    }
  }
  if (totalAmount <= 0) return null;

  const date = todayIso();
  const now = new Date();
  const txns = Object.entries(claimed).map(([source, amount]) => ({
    userId,
    guildId,
    amount,
    source,
    meta: { aggregated: true, reason: opts.reason || "flush" },
    date,
    createdAt: now,
  }));
  await client.coinTransactionsCollection
    .insertMany(txns)
    .catch((e) => console.log(`[CHAT-BUFFER] insert txns: ${e}`.red));

  const inc = { totalCoins: totalAmount, lifetimeCoins: totalAmount };
  for (const [src, amt] of Object.entries(claimed)) {
    inc[`coinsFrom_${src}`] = amt;
  }
  await client.userCoinsCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: now } },
  );

  return { granted: totalAmount, claimed };
}

// 掃所有有 pending 的 buffer 統一 flush（給每日 cron 用）
async function flushAllBuffers(client, guildId = null) {
  if (!client.userCoinsCollection) return { flushed: 0, total: 0 };
  const filter = {
    $or: CHAT_SOURCES.map((s) => ({
      [`chatBuffer.pending.${s}`]: { $gt: 0 },
    })),
  };
  if (guildId) filter.guildId = guildId;

  const cursor = client.userCoinsCollection
    .find(filter)
    .project({ userId: 1, guildId: 1 });

  let flushed = 0;
  let total = 0;
  for await (const doc of cursor) {
    const res = await flushUserBuffer(client, doc.userId, doc.guildId, {
      reason: "scheduled",
    }).catch((e) => {
      console.log(`[CHAT-BUFFER] flushAll user ${doc.userId}: ${e}`.red);
      return null;
    });
    if (res?.granted > 0) {
      flushed += 1;
      total += res.granted;
    }
  }
  return { flushed, total };
}

// 讀指定玩家某個聊天 source 的上次 inc 時間（給 cooldown 檢查用）
async function getLastChatAt(client, userId, guildId, source) {
  if (!client.userCoinsCollection) return null;
  const doc = await client.userCoinsCollection.findOne(
    { userId, guildId },
    { projection: { [`chatBuffer.lastAt.${source}`]: 1 } },
  );
  const ts = doc?.chatBuffer?.lastAt?.[source];
  return ts ? new Date(ts) : null;
}

module.exports = {
  CHAT_SOURCES,
  addToBuffer,
  flushUserBuffer,
  flushAllBuffers,
  getLastChatAt,
};
