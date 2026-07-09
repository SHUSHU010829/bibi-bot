require("colors");
const { DateTime } = require("luxon");
const { bank, coinSystem } = require("../../config");

// 信用分：只存「累積分數」這個來源，實際額度/次數/定存加開/貸款額度一律讀取時由 tier 換算，
// 伺服器年資加成也在讀取時即時算（compute-on-read，不寫死進 DB）。

function cfg() {
  return bank?.credit || {};
}

function timezone() {
  return coinSystem?.daily?.resetTimezone || "Asia/Taipei";
}

function tiers() {
  const list = cfg().tiers || [];
  return [...list].sort((a, b) => a.min - b.min);
}

function resolveTier(score) {
  const list = tiers();
  let cur = list[0] || { name: "信用", emoji: "⚪", transferMax: 0, dailyCap: 0, dailyCount: 1, depositSlotBonus: 0, loanCap: 0 };
  for (const t of list) {
    if (score >= t.min) cur = t;
  }
  return cur;
}

function nextTier(score) {
  return tiers().find((t) => t.min > score) || null;
}

function tenureBonus(member) {
  const joinedTs = member?.joinedTimestamp;
  if (!joinedTs) return 0;
  const days = (Date.now() - joinedTs) / 86400000;
  const per = cfg().tenureBonusPerDay ?? 0;
  const cap = cfg().tenureBonusCap ?? 0;
  return Math.min(cap, Math.floor(days * per));
}

function clampScore(score) {
  const min = cfg().minScore ?? 0;
  const max = cfg().maxScore ?? 1000;
  return Math.max(min, Math.min(max, score));
}

async function getProfile(client, userId, guildId) {
  const col = client.creditProfilesCollection;
  if (!col) return { userId, guildId, score: cfg().baseScore ?? 100 };
  const now = new Date();
  const res = await col.findOneAndUpdate(
    { userId, guildId },
    {
      $setOnInsert: {
        userId,
        guildId,
        score: cfg().baseScore ?? 100,
        gainDate: null,
        gainToday: 0,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  return res.value || res;
}

// 綜合分數（累積分 + 年資加成），clamp 到範圍。member 可省略。
async function effectiveScore(client, userId, guildId, member) {
  const profile = await getProfile(client, userId, guildId);
  const base = typeof profile.score === "number" ? profile.score : cfg().baseScore ?? 100;
  return clampScore(base + tenureBonus(member));
}

// 讀取端一次算出所有銀行相關額度。
async function getLimits(client, userId, guildId, member) {
  const score = await effectiveScore(client, userId, guildId, member);
  const tier = resolveTier(score);
  return {
    score,
    tier,
    next: nextTier(score),
    transferMax: tier.transferMax,
    dailyCap: tier.dailyCap,
    dailyCount: tier.dailyCount,
    depositSlotBonus: tier.depositSlotBonus || 0,
    loanCap: tier.loanCap || 0,
  };
}

// 依 reason 調整分數。正向增益受每日上限限制；扣分不受限。回傳 { score, delta }。
// opts.amount：動態獎勵（例如貸款依本金級距換算），有給就蓋過 scoring 表的固定值。
async function award(client, userId, guildId, reason, opts = {}) {
  if (!cfg().enabled) return null;
  const col = client.creditProfilesCollection;
  if (!col) return null;
  const baseDelta = typeof opts.amount === "number" ? opts.amount : (cfg().scoring || {})[reason];
  if (typeof baseDelta !== "number" || baseDelta === 0) return null;

  const profile = await getProfile(client, userId, guildId);
  const tz = timezone();
  const today = DateTime.now().setZone(tz).toISODate();

  let delta = baseDelta;
  let gainToday = profile.gainDate === today ? profile.gainToday || 0 : 0;

  if (baseDelta > 0) {
    const cap = cfg().dailyGainCap ?? Infinity;
    const remaining = Math.max(0, cap - gainToday);
    delta = Math.min(baseDelta, remaining);
    if (delta <= 0) return { score: clampScore(profile.score), delta: 0 };
    gainToday += delta;
  }

  const nextScore = clampScore((profile.score || 0) + delta);
  const update = {
    $set: { score: nextScore, updatedAt: new Date() },
  };
  if (baseDelta > 0) {
    update.$set.gainDate = today;
    update.$set.gainToday = gainToday;
  }

  await col.updateOne({ userId, guildId }, update).catch((e) =>
    console.log(`[CREDIT] award 失敗 ${reason}: ${e.message}`.yellow),
  );
  return { score: nextScore, delta, reason, mult: opts.mult };
}

// 多次同 reason 扣分（例如逾期天數）——扣分不受每日上限。
async function penalize(client, userId, guildId, reason, times = 1) {
  const col = client.creditProfilesCollection;
  if (!col) return null;
  const per = (cfg().scoring || {})[reason];
  if (typeof per !== "number" || per >= 0) return null;
  const profile = await getProfile(client, userId, guildId);
  const nextScore = clampScore((profile.score || 0) + per * times);
  await col.updateOne(
    { userId, guildId },
    { $set: { score: nextScore, updatedAt: new Date() } },
  );
  return { score: nextScore, delta: per * times };
}

// 被判定洗幣：一天最多扣一次（避免同一對來回轉帳每筆都重複扣分）。
async function flagSuspicious(client, userId, guildId) {
  const col = client.creditProfilesCollection;
  if (!col) return null;
  const per = (cfg().scoring || {}).suspicious_flag;
  if (typeof per !== "number" || per >= 0) return null;
  const today = DateTime.now().setZone(timezone()).toISODate();
  const profile = await getProfile(client, userId, guildId);
  if (profile.suspiciousFlagDate === today) return null;
  const nextScore = clampScore((profile.score || 0) + per);
  const applied = nextScore - (profile.score || 0); // 實際扣掉的分（可能因觸底而小於設定值）
  await col
    .updateOne(
      { userId, guildId },
      { $set: { score: nextScore, suspiciousFlagDate: today, updatedAt: new Date() } },
    )
    .catch((e) => console.log(`[CREDIT] flagSuspicious 失敗: ${e.message}`.yellow));
  return { score: nextScore, delta: applied };
}

// 復原誤扣：把 points（正數）加回，並清掉今日洗幣標記。
async function restore(client, userId, guildId, points) {
  const col = client.creditProfilesCollection;
  if (!col) return null;
  const p = Math.abs(Number(points) || 0);
  if (p <= 0) return null;
  const profile = await getProfile(client, userId, guildId);
  const nextScore = clampScore((profile.score || 0) + p);
  await col
    .updateOne(
      { userId, guildId },
      { $set: { score: nextScore, suspiciousFlagDate: null, updatedAt: new Date() } },
    )
    .catch((e) => console.log(`[CREDIT] restore 失敗: ${e.message}`.yellow));
  return { score: nextScore, restored: p };
}

module.exports = {
  cfg,
  tiers,
  resolveTier,
  nextTier,
  tenureBonus,
  getProfile,
  effectiveScore,
  getLimits,
  award,
  penalize,
  flagSuspicious,
  restore,
};
