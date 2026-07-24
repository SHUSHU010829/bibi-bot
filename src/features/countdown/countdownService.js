const { ObjectId } = require("mongodb");
const { DateTime } = require("luxon");

const { countdown: cfg } = require("../../config");

const TZ = () => cfg?.timezone || "Asia/Taipei";
const MILESTONES = () => cfg?.milestoneDays || [30, 14, 7, 3, 1];

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
  TZ,
};
