const { DateTime } = require("luxon");
const { boss } = require("../../config");

// 召喚場的「出沒時段」：能量集滿不再當場登場，改成排進台灣時間的晚上時段隨機挑一個時刻，
// 前 preNotice.minutesBefore 分鐘先在通知頻道預告。存來源不存結果：只存 spawn_at，
// 之後的預告 / 登場都由每分鐘的掃描依當下時間判定。

function cfg() {
  return boss?.summon?.spawnWindow || {};
}

function noticeMinutes() {
  return boss?.preNotice?.enabled ? (boss.preNotice.minutesBefore ?? 0) : 0;
}

function timezone() {
  return cfg().timezone || boss?.saturdaySpawn?.timezone || "Asia/Taipei";
}

function enabled() {
  return !!cfg().enabled;
}

function bounds(day) {
  return {
    start: day.set({
      hour: cfg().startHour ?? 19,
      minute: cfg().startMinute ?? 0,
      second: 0,
      millisecond: 0,
    }),
    end: day.set({
      hour: cfg().endHour ?? 23,
      minute: cfg().endMinute ?? 0,
      second: 0,
      millisecond: 0,
    }),
  };
}

// 從 fromMs 之後最近一個「還來得及預告」的時段裡隨機挑一個出沒時刻。
// 今天的時段已經過了（或剩下的時間不夠預告）就順延到明天。
function pickSpawnAt(fromMs = Date.now()) {
  const now = DateTime.fromMillis(fromMs, { zone: timezone() });
  const lead = noticeMinutes() + (cfg().minLeadMinutes ?? 3);
  for (let offset = 0; offset <= 1; offset++) {
    const { start, end } = bounds(now.plus({ days: offset }));
    const earliest = DateTime.max(start, now.plus({ minutes: lead }));
    if (earliest <= end) {
      return Math.round(earliest.toMillis() + Math.random() * end.diff(earliest).as("milliseconds"));
    }
  }
  return null;
}

function noticeAt(spawnAt) {
  return spawnAt - noticeMinutes() * 60 * 1000;
}

// UI 用：「19:10–22:50」
function windowLabel() {
  const pad = (n) => String(n).padStart(2, "0");
  const s = `${pad(cfg().startHour ?? 19)}:${pad(cfg().startMinute ?? 0)}`;
  const e = `${pad(cfg().endHour ?? 23)}:${pad(cfg().endMinute ?? 0)}`;
  return `${s}–${e}`;
}

module.exports = {
  cfg,
  enabled,
  timezone,
  pickSpawnAt,
  noticeAt,
  noticeMinutes,
  windowLabel,
};
