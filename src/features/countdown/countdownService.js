const { ObjectId } = require("mongodb");
const { DateTime } = require("luxon");

const { countdown: cfg } = require("../../config");

const TZ = () => cfg?.timezone || "Asia/Taipei";
const MILESTONES = () => cfg?.milestoneDays || [30, 14, 7, 3, 1];
const INTERVAL = () => cfg?.interval || {};
const MODE_INTERVAL = "interval";

// 使用者輸入日期解析：接受 yyyy-MM-dd / yyyy/MM/dd，時間 HH:mm（選填）。
// 只寫月日（MM-dd）時自動補當年，若已過則補明年。
function parseTarget(dateStr, timeStr) {
  const tz = TZ();
  const raw = (dateStr || "").trim().replace(/\//g, "-");
  const time = (timeStr || "").trim();

  let dt = null;
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const md = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (full) {
    dt = DateTime.fromObject(
      { year: +full[1], month: +full[2], day: +full[3] },
      { zone: tz },
    );
  } else if (md) {
    const now = DateTime.now().setZone(tz);
    dt = DateTime.fromObject(
      { year: now.year, month: +md[1], day: +md[2] },
      { zone: tz },
    );
    if (dt.isValid && dt.startOf("day") < now.startOf("day")) {
      dt = dt.plus({ years: 1 });
    }
  }
  if (!dt || !dt.isValid) return null;

  if (time) {
    const t = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!t) return null;
    dt = dt.set({ hour: +t[1], minute: +t[2], second: 0, millisecond: 0 });
  } else {
    dt = dt.startOf("day");
  }
  if (!dt.isValid) return null;
  return dt;
}

// 以「日曆天」計算剩餘天數（不看時分），符合里程碑語意。
function daysUntil(targetAt, now = new Date()) {
  const tz = TZ();
  const target = DateTime.fromJSDate(targetAt, { zone: tz }).startOf("day");
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  return Math.round(target.diff(today, "days").days);
}

// 建立時預先標記「已經錯過」的里程碑，避免補報過去的天數。
function initialAnnounced(daysLeft) {
  return MILESTONES().filter((d) => d > daysLeft);
}

async function createCountdown(client, { guildId, channelId, createdBy, title, description, targetAt }) {
  const daysLeft = daysUntil(targetAt);
  const doc = {
    guildId,
    channelId,
    createdBy,
    title,
    description: description || "",
    targetAt,
    announced: initialAnnounced(daysLeft),
    finished: false,
    createdAt: new Date(),
  };
  const { insertedId } = await client.countdownsCollection.insertOne(doc);
  doc._id = insertedId;
  return doc;
}

function isIntervalMode(doc) {
  return doc?.mode === MODE_INTERVAL;
}

function intervalLabel(minutes) {
  const hit = (INTERVAL().choices || []).find((c) => c.minutes === minutes);
  if (hit) return hit.name;
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小時`;
  return `每 ${minutes} 分鐘`;
}

function parseHm(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((str || "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
}

function hmLabel(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// 每日時段：dailyStartMin > dailyEndMin 視為跨午夜（例 22:00～02:00）。沒設定則全天。
function inDailyWindow(s, ms) {
  if (s.dailyStartMin == null || s.dailyEndMin == null) return true;
  const dt = DateTime.fromMillis(ms, { zone: TZ() });
  const m = dt.hour * 60 + dt.minute;
  return s.dailyStartMin <= s.dailyEndMin
    ? m >= s.dailyStartMin && m <= s.dailyEndMin
    : m >= s.dailyStartMin || m <= s.dailyEndMin;
}

// 提醒時間點固定對齊 startAt + k × 間隔，且落在每日時段內。
// 回傳 ≥ t 的第一個時間點；期間內已沒有則回 null。
function firstSlotAtOrAfter(s, t) {
  const step = s.intervalMinutes * 60_000;
  const start = new Date(s.startAt).getTime();
  const end = new Date(s.endAt).getTime();
  const at = new Date(t).getTime();
  let ms = at <= start ? start : start + Math.ceil((at - start) / step) * step;
  for (; ms <= end; ms += step) {
    if (inDailyWindow(s, ms)) return new Date(ms);
  }
  return null;
}

// 期間內、時間 ≤ upTo 的提醒次數。
function countSlots(s, upTo = s.endAt) {
  const step = s.intervalMinutes * 60_000;
  const start = new Date(s.startAt).getTime();
  const last = Math.min(new Date(upTo).getTime(), new Date(s.endAt).getTime());
  let n = 0;
  for (let ms = start; ms <= last; ms += step) {
    if (inDailyWindow(s, ms)) n += 1;
  }
  return n;
}

// 期間提醒的建立前檢查。回傳 { ok: true, startAt, endAt, dailyStartMin, dailyEndMin, nextAt, total, remaining }
// 或 { ok: false, reason, ... }，由指令層轉成錯誤 Container。
function planInterval(
  { startDate, startTime, endDate, endTime, intervalMinutes, dailyStart, dailyEnd },
  now = new Date(),
) {
  const icfg = INTERVAL();
  const start = parseTarget(startDate, startTime || icfg.defaultStartTime || "09:00");
  if (!start) return { ok: false, reason: "bad_start" };
  const end = parseTarget(endDate, endTime || icfg.defaultEndTime || "22:00");
  if (!end) return { ok: false, reason: "bad_end" };
  const dailyStartMin = parseHm(dailyStart || icfg.dailyStart || "09:00");
  const dailyEndMin = parseHm(dailyEnd || icfg.dailyEnd || "22:00");
  if (dailyStartMin == null || dailyEndMin == null) return { ok: false, reason: "bad_window" };

  const startAt = start.toJSDate();
  const endAt = end.toJSDate();
  const base = { startAt, endAt, dailyStartMin, dailyEndMin };
  if (endAt < startAt) return { ok: false, reason: "end_before_start", ...base };
  if (endAt <= now) return { ok: false, reason: "ended", ...base };

  const s = { ...base, intervalMinutes };
  const nextAt = firstSlotAtOrAfter(s, now);
  if (!nextAt) return { ok: false, reason: "no_slot", ...base };

  const total = countSlots(s);
  const remaining = total - countSlots(s, nextAt.getTime() - 1);
  const max = icfg.maxReminders || 200;
  if (remaining > max) {
    return { ok: false, reason: "too_many", ...base, remaining, max };
  }
  return { ok: true, ...base, nextAt, total, remaining };
}

async function createIntervalReminder(
  client,
  {
    guildId,
    channelId,
    createdBy,
    title,
    description,
    startAt,
    endAt,
    dailyStartMin,
    dailyEndMin,
    nextAt,
    intervalMinutes,
  },
) {
  const doc = {
    mode: MODE_INTERVAL,
    guildId,
    channelId,
    createdBy,
    title,
    description: description || "",
    // targetAt 沿用為「結束時間」，讓列表排序、autocomplete 剩餘天數與倒數共用。
    targetAt: endAt,
    startAt,
    endAt,
    dailyStartMin,
    dailyEndMin,
    intervalMinutes,
    nextAt,
    sentCount: 0,
    finished: false,
    createdAt: new Date(),
  };
  const { insertedId } = await client.countdownsCollection.insertOne(doc);
  doc._id = insertedId;
  return doc;
}

// 以 nextAt 為條件原子地領取這一輪，避免多個 tick 重疊時重複發送。
// bot 停機後恢復只補發一次，nextAt 直接跳到下一個未來時間點；
// 恢復時若已在每日時段外（例如半夜才上線）則不補發，只推進 nextAt。
async function claimIntervalReminder(client, doc, now = new Date()) {
  const next = firstSlotAtOrAfter(doc, now.getTime() + 1);
  const isLast = !next;
  const skipped = !inDailyWindow(doc, now.getTime());
  const $set = isLast
    ? { finished: true, finishedAt: now }
    : { nextAt: next };
  if (!skipped) $set.lastSentAt = now;
  const res = await client.countdownsCollection.updateOne(
    { _id: doc._id, finished: false, nextAt: doc.nextAt },
    skipped ? { $set } : { $set, $inc: { sentCount: 1 } },
  );
  if (!res.modifiedCount) return null;
  return {
    skipped,
    isLast,
    nextAt: next,
    index: countSlots(doc, now),
    total: countSlots(doc),
  };
}

async function listDueIntervalReminders(client, now = new Date()) {
  return client.countdownsCollection
    .find({ mode: MODE_INTERVAL, finished: false, nextAt: { $lte: now } })
    .sort({ nextAt: 1 })
    .toArray();
}

async function listCountdowns(client, guildId) {
  return client.countdownsCollection
    .find({ guildId, finished: false })
    .sort({ targetAt: 1 })
    .toArray();
}

async function deleteCountdown(client, guildId, id) {
  let oid;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }
  const doc = await client.countdownsCollection.findOne({ _id: oid, guildId });
  if (!doc) return null;
  await client.countdownsCollection.deleteOne({ _id: oid });
  return doc;
}

// 決定某筆倒數這次該不該播報。回傳 null 或 { kind, days }。
//   arrival：到期當天（或已過）播一次後結束。
//   milestone：剩餘天數命中 milestoneDays 且尚未播過。
function dueAnnouncement(doc, now = new Date()) {
  if (isIntervalMode(doc)) return null;
  const daysLeft = daysUntil(doc.targetAt, now);
  if (daysLeft <= 0) return { kind: "arrival", days: 0 };
  if (MILESTONES().includes(daysLeft) && !(doc.announced || []).includes(daysLeft)) {
    return { kind: "milestone", days: daysLeft };
  }
  return null;
}

module.exports = {
  parseTarget,
  daysUntil,
  createCountdown,
  listCountdowns,
  deleteCountdown,
  dueAnnouncement,
  isIntervalMode,
  intervalLabel,
  hmLabel,
  planInterval,
  createIntervalReminder,
  claimIntervalReminder,
  listDueIntervalReminders,
  MODE_INTERVAL,
  TZ,
};
