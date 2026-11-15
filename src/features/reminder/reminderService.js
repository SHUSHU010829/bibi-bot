const { ObjectId } = require("mongodb");
const { DateTime } = require("luxon");

const { reminder: cfg } = require("../../config");
const { TZ } = require("./timeParser");

// 資料模型：
//   Reminders     一筆提醒（個人 / 揪團），只存「來源狀態」：錨點時間、重複規則、目前第幾次（dueAt）、
//                 參加者各自的提前 / 追加設定。
//   ReminderJobs  排好的單次任務。每分鐘 tick 撈 fireAt 已到的任務、原子刪除（領取）後執行：
//                   advance  該次到點 → 推進到下一次（重複）或結束，並替所有參加者排下一次的任務
//                   lead     提前提醒
//                   due      到點提醒（含延後）；發完後若有設定追加提醒就排第一則 nag
//                   nag      追加提醒，直到按「完成」或次數用完
//   每位參加者的任務獨立，所以揪團成員可以各自微調提前時間、追加頻率，互不影響。

const KIND_PERSONAL = "personal";
const KIND_GROUP = "group";

const STEP = {
  daily: { days: 1 },
  weekdays: { days: 1 },
  weekends: { days: 1 },
  weekly: { weeks: 1 },
  biweekly: { weeks: 2 },
  monthly: { months: 1 },
  quarterly: { months: 3 },
  halfyear: { months: 6 },
  yearly: { years: 1 },
};

function isRepeating(rem) {
  return !!STEP[rem?.repeat];
}

function matchesRepeat(repeat, dt) {
  if (repeat === "weekdays") return dt.weekday <= 5;
  if (repeat === "weekends") return dt.weekday >= 6;
  return true;
}

// 永遠從錨點加 n 個步長，而不是從上一次累加：1/31 每月 → 2/28 → 3/31，不會漂移成每月 28 號。
function occurrenceAt(anchorAt, repeat, n) {
  const step = STEP[repeat];
  const anchor = DateTime.fromJSDate(anchorAt, { zone: TZ() });
  const scaled = Object.fromEntries(Object.entries(step).map(([k, v]) => [k, v * n]));
  return anchor.plus(scaled);
}

// 回傳嚴格晚於 after 的下一次 { at, index }；沒有了（不重複 / 超過重複到期日）回 null。
function nextOccurrence(rem, after) {
  if (!isRepeating(rem)) return null;
  const afterMs = new Date(after).getTime();
  const until = rem.repeatUntil ? new Date(rem.repeatUntil).getTime() : Infinity;
  const limit = cfg?.maxOccurrenceScan || 5000;
  for (let n = (rem.occurrenceIndex || 0) + 1, i = 0; i < limit; n += 1, i += 1) {
    const dt = occurrenceAt(rem.anchorAt, rem.repeat, n);
    if (dt.toMillis() > until) return null;
    if (!matchesRepeat(rem.repeat, dt)) continue;
    if (dt.toMillis() > afterMs) return { at: dt.toJSDate(), index: n };
  }
  return null;
}

// 建立時若第一次就落在不符合的日子（例：「平日」卻選了週六），往後找第一個符合的。
function firstOccurrence(at, repeat) {
  const dt = DateTime.fromJSDate(at, { zone: TZ() });
  if (!isRepeating({ repeat }) || matchesRepeat(repeat, dt)) return { at, index: 0 };
  return nextOccurrence({ anchorAt: at, repeat, occurrenceIndex: 0 }, at);
}

function toObjectId(id) {
  try {
    return id instanceof ObjectId ? id : new ObjectId(String(id));
  } catch {
    return null;
  }
}

function participantOf(rem, userId) {
  return (rem?.participants || []).find((p) => p.userId === userId) || null;
}

function buildParticipant(userId, { leadMinutes = 0, nagMinutes = 0, nagCount } = {}) {
  return {
    userId,
    leadMinutes,
    nagMinutes,
    nagCount: nagCount ?? cfg?.defaultNagCount ?? 3,
    joinedAt: new Date(),
  };
}

function userJobsFor(rem, participant, now = new Date()) {
  const jobs = [];
  const due = new Date(rem.dueAt);
  if (due <= now) return jobs;
  const base = { reminderId: rem._id, userId: participant.userId, occurrenceAt: due };
  if (participant.leadMinutes > 0) {
    const leadAt = new Date(due.getTime() - participant.leadMinutes * 60_000);
    if (leadAt > now) jobs.push({ ...base, kind: "lead", fireAt: leadAt });
  }
  jobs.push({ ...base, kind: "due", fireAt: due });
  return jobs;
}

async function insertJobs(client, jobs) {
  if (jobs.length) await client.reminderJobsCollection.insertMany(jobs);
}

async function createReminder(
  client,
  { kind, guildId, channelId, ownerId, title, note, at, repeat, repeatUntil, leadMinutes, nagMinutes, nagCount },
) {
  const first = firstOccurrence(at, repeat);
  if (!first) return { ok: false, reason: "no_occurrence" };
  const doc = {
    kind,
    guildId,
    channelId,
    messageId: null,
    ownerId,
    title,
    note: note || "",
    repeat: isRepeating({ repeat }) ? repeat : "none",
    repeatUntil: repeatUntil || null,
    anchorAt: at,
    occurrenceIndex: first.index,
    dueAt: first.at,
    defaultLeadMinutes: leadMinutes || 0,
    participants: [buildParticipant(ownerId, { leadMinutes, nagMinutes, nagCount })],
    finished: false,
    createdAt: new Date(),
  };
  if (repeatUntil && first.at > repeatUntil) return { ok: false, reason: "until_before_first" };
  const { insertedId } = await client.remindersCollection.insertOne(doc);
  doc._id = insertedId;
  await insertJobs(client, [
    { reminderId: insertedId, userId: null, kind: "advance", fireAt: doc.dueAt, occurrenceAt: doc.dueAt },
    ...userJobsFor(doc, doc.participants[0]),
  ]);
  return { ok: true, reminder: doc };
}

async function setMessageId(client, reminderId, messageId) {
  await client.remindersCollection.updateOne({ _id: reminderId }, { $set: { messageId } });
}

async function getReminder(client, id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  return client.remindersCollection.findOne({ _id: oid });
}

async function listForUser(client, userId) {
  return client.remindersCollection
    .find({ finished: false, "participants.userId": userId })
    .sort({ dueAt: 1 })
    .toArray();
}

async function countPersonal(client, userId) {
  return client.remindersCollection.countDocuments({ kind: KIND_PERSONAL, ownerId: userId, finished: false });
}

async function countGroups(client, guildId) {
  return client.remindersCollection.countDocuments({ kind: KIND_GROUP, guildId, finished: false });
}

async function joinGroup(client, id, userId) {
  const rem = await getReminder(client, id);
  if (!rem || rem.kind !== KIND_GROUP) return { ok: false, reason: "not_found" };
  if (rem.finished) return { ok: false, reason: "finished", reminder: rem };
  if (participantOf(rem, userId)) return { ok: false, reason: "already", reminder: rem };
  const max = cfg?.maxParticipants || 100;
  const participant = buildParticipant(userId, { leadMinutes: rem.defaultLeadMinutes });
  const res = await client.remindersCollection.findOneAndUpdate(
    {
      _id: rem._id,
      finished: false,
      "participants.userId": { $ne: userId },
      [`participants.${max - 1}`]: { $exists: false },
    },
    { $push: { participants: participant } },
    { returnDocument: "after" },
  );
  if (!res) {
    const fresh = await getReminder(client, id);
    if (fresh && participantOf(fresh, userId)) return { ok: false, reason: "already", reminder: fresh };
    if (fresh && !fresh.finished) return { ok: false, reason: "full", reminder: fresh, max };
    return { ok: false, reason: fresh ? "finished" : "not_found", reminder: fresh };
  }
  await insertJobs(client, userJobsFor(res, participant));
  return { ok: true, reminder: res, participant };
}

async function leaveGroup(client, id, userId) {
  const oid = toObjectId(id);
  if (!oid) return { ok: false, reason: "not_found" };
  const res = await client.remindersCollection.findOneAndUpdate(
    { _id: oid, kind: KIND_GROUP, "participants.userId": userId },
    { $pull: { participants: { userId } } },
    { returnDocument: "after" },
  );
  if (!res) {
    const rem = await getReminder(client, oid);
    return { ok: false, reason: rem ? "not_joined" : "not_found", reminder: rem };
  }
  await client.reminderJobsCollection.deleteMany({ reminderId: oid, userId });
  return { ok: true, reminder: res };
}

const SETTABLE = new Set(["leadMinutes", "nagMinutes", "nagCount"]);

async function updateParticipant(client, id, userId, field, value) {
  if (!SETTABLE.has(field)) throw new Error(`updateParticipant: 不支援的欄位 ${field}`);
  const oid = toObjectId(id);
  if (!oid) return { ok: false, reason: "not_found" };
  const res = await client.remindersCollection.findOneAndUpdate(
    { _id: oid, "participants.userId": userId },
    { $set: { [`participants.$.${field}`]: value } },
    { returnDocument: "after" },
  );
  if (!res) return { ok: false, reason: "not_found" };

  // 追加設定在每次到點時才讀，不用重排；提前時間要重排本次的 lead 任務。
  if (field === "leadMinutes" && !res.finished) {
    await client.reminderJobsCollection.deleteMany({
      reminderId: oid,
      userId,
      kind: "lead",
      occurrenceAt: res.dueAt,
    });
    const lead = userJobsFor(res, participantOf(res, userId)).filter((j) => j.kind === "lead");
    await insertJobs(client, lead);
  }
  return { ok: true, reminder: res };
}

async function cancelReminder(client, id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const rem = await client.remindersCollection.findOneAndDelete({ _id: oid });
  if (rem) await client.reminderJobsCollection.deleteMany({ reminderId: oid });
  return rem;
}

function occurrenceFilter(reminderId, userId, occurrenceAt) {
  return { reminderId, userId, occurrenceAt: new Date(occurrenceAt) };
}

// 按「完成」：停掉這一次剩下的追加 / 延後。不重複的個人提醒順便結束。
async function markDone(client, rem, userId, occurrenceAt) {
  await client.reminderJobsCollection.deleteMany(occurrenceFilter(rem._id, userId, occurrenceAt));
  if (rem.kind === KIND_PERSONAL && !isRepeating(rem) && !rem.finished) {
    await finish(client, rem._id);
  }
}

// 「這次不用提醒」：在提前提醒時就跳過本次到點與追加。
async function skipOccurrence(client, rem, userId, occurrenceAt) {
  await client.reminderJobsCollection.deleteMany(occurrenceFilter(rem._id, userId, occurrenceAt));
}

async function snooze(client, rem, userId, occurrenceAt, minutes, now = new Date()) {
  await client.reminderJobsCollection.deleteMany(occurrenceFilter(rem._id, userId, occurrenceAt));
  const fireAt = new Date(now.getTime() + minutes * 60_000);
  await insertJobs(client, [
    { reminderId: rem._id, userId, kind: "due", fireAt, occurrenceAt: new Date(occurrenceAt), snoozed: true },
  ]);
  return fireAt;
}

async function finish(client, reminderId, now = new Date()) {
  await client.remindersCollection.updateOne(
    { _id: reminderId, finished: false },
    { $set: { finished: true, finishedAt: now } },
  );
}

async function listDueJobs(client, now = new Date()) {
  return client.reminderJobsCollection
    .find({ fireAt: { $lte: now } })
    .sort({ fireAt: 1 })
    .limit(cfg?.jobsPerTick || 200)
    .toArray();
}

// 領取並執行一筆任務。回傳要送出的通知（由 scheduler 負責發 Discord 訊息），沒有則回 null。
//   { type: "deliver", reminder, participant, kind, occurrenceAt, nagIndex, nagTotal, snoozed }
//   { type: "advanced", reminder, previousDueAt, ended }
async function processJob(client, job, now = new Date()) {
  const claimed = await client.reminderJobsCollection.findOneAndDelete({ _id: job._id });
  if (!claimed) return null;
  const rem = await client.remindersCollection.findOne({ _id: claimed.reminderId });
  if (!rem) return null;

  if (claimed.kind === "advance") {
    if (rem.finished || new Date(rem.dueAt).getTime() !== new Date(claimed.occurrenceAt).getTime()) return null;
    const next = nextOccurrence(rem, now);
    if (!next) {
      await finish(client, rem._id, now);
      return { type: "advanced", reminder: { ...rem, finished: true }, previousDueAt: rem.dueAt, ended: true };
    }
    const updated = await client.remindersCollection.findOneAndUpdate(
      { _id: rem._id, dueAt: rem.dueAt },
      { $set: { dueAt: next.at, occurrenceIndex: next.index } },
      { returnDocument: "after" },
    );
    if (!updated) return null;
    await insertJobs(client, [
      { reminderId: rem._id, userId: null, kind: "advance", fireAt: next.at, occurrenceAt: next.at },
      ...updated.participants.flatMap((p) => userJobsFor(updated, p, now)),
    ]);
    return { type: "advanced", reminder: updated, previousDueAt: rem.dueAt, ended: false };
  }

  const participant = participantOf(rem, claimed.userId);
  if (!participant) return null;
  // bot 離線錯過的提前提醒：到點都過了就不用再「提前」。
  if (claimed.kind === "lead" && now >= new Date(claimed.occurrenceAt)) return null;

  const nagTotal = participant.nagMinutes > 0 ? participant.nagCount : 0;
  const nagIndex = claimed.kind === "nag" ? claimed.nagIndex : 0;
  if (claimed.kind !== "lead" && nagIndex < nagTotal) {
    await insertJobs(client, [
      {
        reminderId: rem._id,
        userId: participant.userId,
        kind: "nag",
        nagIndex: nagIndex + 1,
        fireAt: new Date(now.getTime() + participant.nagMinutes * 60_000),
        occurrenceAt: claimed.occurrenceAt,
      },
    ]);
  }
  return {
    type: "deliver",
    reminder: rem,
    participant,
    kind: claimed.kind,
    occurrenceAt: claimed.occurrenceAt,
    nagIndex,
    nagTotal,
    snoozed: !!claimed.snoozed,
  };
}

module.exports = {
  KIND_PERSONAL,
  KIND_GROUP,
  isRepeating,
  nextOccurrence,
  firstOccurrence,
  participantOf,
  createReminder,
  setMessageId,
  getReminder,
  listForUser,
  countPersonal,
  countGroups,
  joinGroup,
  leaveGroup,
  updateParticipant,
  cancelReminder,
  markDone,
  skipOccurrence,
  snooze,
  listDueJobs,
  processJob,
};
