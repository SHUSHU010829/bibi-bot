// 盜賊系統的玩家狀態：惡名（notoriety）、防身道具、統計。
// 惡名採「compute-on-read 衰退」：只存原始值 + 結算基準日，讀取時才依「幾天沒偷」扣減，
// 符合 CLAUDE.md「存來源不存結果」。寫入前一律先 settle 再套 delta，避免重複衰退。
const { DateTime } = require("luxon");
const { theft } = require("../../config");

function tz() {
  return theft?.timezone || "Asia/Taipei";
}

function today() {
  return DateTime.now().setZone(tz()).toISODate();
}

function decayPerDay() {
  return theft?.notoriety?.decayPerDay ?? 1;
}

// 從結算基準日到今天，沒偷竊就每天扣 decayPerDay。
function effectiveNotoriety(doc, ref = today()) {
  const raw = doc?.notoriety || 0;
  if (raw <= 0) return 0;
  const anchor = doc?.notoriety_as_of || ref;
  const days = Math.floor(
    DateTime.fromISO(ref).diff(DateTime.fromISO(anchor), "days").days
  );
  if (days <= 0) return raw;
  return Math.max(0, raw - days * decayPerDay());
}

function defaultDoc(userId, guildId) {
  const now = new Date();
  return {
    userId,
    guildId,
    notoriety: 0,
    notoriety_as_of: today(),
    lifetime_stolen: 0,
    steal_success: 0,
    steal_fail: 0,
    hunt_success: 0,
    defend_success: 0,
    watchdog_count: 0,
    safebox_expires_at: 0,
    night_cloak_count: 0,
    sting_count: 0,
    free_report: false,
    parole_until: 0,
    surrender_history: [],
    last_steal_date: null,
    createdAt: now,
  };
}

async function getOrCreate(client, userId, guildId) {
  const res = await client.theftProfilesCollection.findOneAndUpdate(
    { userId, guildId },
    { $setOnInsert: defaultDoc(userId, guildId), $set: { updatedAt: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  const doc = res.value || res;
  doc.notoriety_effective = effectiveNotoriety(doc);
  return doc;
}

// 先把衰退結算進 notoriety，再套用 delta（可負），下限 0。回傳結算後的值。
async function adjustNotoriety(client, userId, guildId, delta) {
  const doc = await getOrCreate(client, userId, guildId);
  const settled = effectiveNotoriety(doc);
  const next = Math.max(0, settled + delta);
  await client.theftProfilesCollection.updateOne(
    { userId, guildId },
    { $set: { notoriety: next, notoriety_as_of: today(), updatedAt: new Date() } }
  );
  return next;
}

function safeboxActive(doc) {
  return (doc?.safebox_expires_at || 0) > Date.now();
}

module.exports = {
  getOrCreate,
  adjustNotoriety,
  effectiveNotoriety,
  safeboxActive,
  today,
};
