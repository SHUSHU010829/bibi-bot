const { DateTime } = require("luxon");

const pad = (n) => String(n).padStart(2, "0");

const weekStartFor = (date, tz) =>
  DateTime.fromJSDate(date, { zone: tz }).startOf("week");

const weekWindowsFor = (range, tz = "Asia/Taipei") => {
  if (!range?.start || !range?.end) return [];
  const start = weekStartFor(range.start, tz);
  const endDt = DateTime.fromJSDate(range.end, { zone: tz });
  const windows = [];
  let cursor = start;
  while (cursor <= endDt) {
    const winEnd = cursor.plus({ weeks: 1 });
    windows.push({
      start: cursor.toJSDate(),
      end: winEnd.toJSDate(),
      label: formatLabel(cursor),
    });
    cursor = winEnd;
  }
  return windows;
};

const formatLabel = (startDt) => {
  const endDt = startDt.plus({ days: 6 });
  return `周表 ${pad(startDt.month)}/${pad(startDt.day)} - ${pad(endDt.month)}/${pad(endDt.day)}`;
};

const nextWeekWindow = (tz = "Asia/Taipei") => {
  const start = DateTime.now().setZone(tz).startOf("week").plus({ weeks: 1 });
  return {
    start: start.toJSDate(),
    end: start.plus({ weeks: 1 }).toJSDate(),
    label: formatLabel(start),
  };
};

const currentWeekWindow = (tz = "Asia/Taipei") => {
  const start = DateTime.now().setZone(tz).startOf("week");
  return {
    start: start.toJSDate(),
    end: start.plus({ weeks: 1 }).toJSDate(),
    label: formatLabel(start),
  };
};

module.exports = {
  weekWindowsFor,
  nextWeekWindow,
  currentWeekWindow,
  formatLabel,
};
