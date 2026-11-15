const { DateTime } = require("luxon");

const { reminder: cfg } = require("../../config");

const TZ = () => cfg?.timezone || "Asia/Taipei";

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAY_WORDS = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 後天: 2, 大後天: 3 };
const REL_UNITS = {
  minutes: ["分鐘", "分", "minutes", "minute", "mins", "min", "m"],
  hours: ["個小時", "個鐘頭", "小時", "鐘頭", "hours", "hour", "hrs", "hr", "h"],
  days: ["天", "days", "day", "d"],
  weeks: ["個星期", "個禮拜", "星期", "禮拜", "週", "周", "weeks", "week", "w"],
};
const UNIT_OF = Object.fromEntries(
  Object.entries(REL_UNITS).flatMap(([unit, words]) => words.map((w) => [w, unit])),
);
const REL_TOKEN = new RegExp(
  `(\\d+|[一二兩三四五六七八九十]+)(${Object.keys(UNIT_OF).sort((a, b) => b.length - a.length).join("|")})`,
  "gy",
);

// 一～九十九的中文數字（「十二」「二十」「三十五」）
function cnNumber(s) {
  if (/^\d+$/.test(s)) return +s;
  if (s in CN_DIGIT) return CN_DIGIT[s];
  const m = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  return null;
}

function normalize(raw) {
  return String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

// 「1h30m」「1小時30分鐘後」「半小時後」「兩個半小時」「90 分鐘」
function parseRelative(text, now) {
  let s = text.replace(/\s+/g, "").replace(/(之後|以後|後)$/, "");
  if (!s) return null;
  s = s.replace(/^半(個)?(小時|鐘頭)$/, "30分").replace(/個?(半(個)?(小時|鐘頭)|(小時|鐘頭)半)$/, "小時30分");

  const parts = {};
  let pos = 0;
  REL_TOKEN.lastIndex = 0;
  let m;
  while (pos < s.length && (m = REL_TOKEN.exec(s)) !== null) {
    const n = cnNumber(m[1]);
    if (n == null) return null;
    const unit = UNIT_OF[m[2]];
    parts[unit] = (parts[unit] || 0) + n;
    pos = REL_TOKEN.lastIndex;
  }
  if (pos === 0 || pos !== s.length) return null;
  const at = now.plus(parts);
  return at > now ? at : null;
}

// 回傳 { hour, minute } 或 null。接受 20:00 / 8:05pm / 晚上8點 / 下午三點半 / 早上9點15分 / 9pm
function parseTimeOfDay(text) {
  let s = text.replace(/\s+/g, "");
  if (!s) return null;

  let period = null;
  const p = /^(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜晚|半夜|今晚)/.exec(s);
  if (p) {
    period = p[1];
    s = s.slice(p[1].length);
  }
  const ap = /(am|pm|a\.m\.|p\.m\.)$/.exec(s);
  if (ap) {
    period = ap[1].startsWith("p") ? "下午" : "上午";
    s = s.slice(0, -ap[1].length);
  }

  let hour = null;
  let minute = 0;
  let m;
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    hour = +m[1];
    minute = +m[2];
  } else if ((m = /^(\d{1,2}|[一二兩三四五六七八九十]+)(點|時)(半|(\d{1,2}|[一二三四五六七八九十]+)分?)?$/.exec(s))) {
    hour = cnNumber(m[1]);
    if (m[3] === "半") minute = 30;
    else if (m[4]) minute = cnNumber(m[4]);
  } else if (period && (m = /^(\d{1,2})$/.exec(s))) {
    hour = +m[1];
  } else {
    return null;
  }
  if (hour == null || minute == null) return null;

  if (period) {
    if (["下午", "傍晚", "晚上", "夜晚", "今晚"].includes(period) && hour < 12) hour += 12;
    else if (period === "中午" && hour < 6) hour += 12;
    else if (["凌晨", "半夜"].includes(period) && hour === 12) hour = 0;
    else if (["上午", "早上", "早晨", "清晨"].includes(period) && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// 回傳 { date: DateTime(startOf day), weekdayOnly: boolean } 或 null；剩下的字串一併回傳
function parseDatePart(text, now) {
  const s = text.trim();
  let m;

  if ((m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日號]?\s*/.exec(s))) {
    const d = DateTime.fromObject({ year: +m[1], month: +m[2], day: +m[3] }, { zone: TZ() });
    return d.isValid ? { date: d, rest: s.slice(m[0].length), explicit: true } : { invalid: true };
  }
  if ((m = /^(\d{1,2})[-/月](\d{1,2})[日號]?(?![\d:])\s*/.exec(s))) {
    const d = DateTime.fromObject({ year: now.year, month: +m[1], day: +m[2] }, { zone: TZ() });
    if (!d.isValid) return { invalid: true };
    return { date: d, rest: s.slice(m[0].length), explicit: true, yearless: true };
  }
  for (const word of Object.keys(DAY_WORDS).sort((a, b) => b.length - a.length)) {
    if (s.startsWith(word)) {
      return { date: now.startOf("day").plus({ days: DAY_WORDS[word] }), rest: s.slice(word.length) };
    }
  }
  if ((m = /^(下下|下個?|這個?|本)?(週|周|星期|禮拜)([一二三四五六日天])\s*/.exec(s))) {
    const target = WEEKDAY[m[3]];
    const thisWeek = now.startOf("day").plus({ days: target - now.weekday });
    let d = thisWeek;
    if (m[1]?.startsWith("下下")) d = thisWeek.plus({ weeks: 2 });
    else if (m[1]?.startsWith("下")) d = thisWeek.plus({ weeks: 1 });
    return { date: d, rest: s.slice(m[0].length), weekday: !m[1] };
  }
  return null;
}

// 解析玩家輸入的提醒時間。回傳 { ok: true, at: Date } 或 { ok: false, reason: "empty" | "invalid" | "past" }
function parseWhen(raw, now = new Date()) {
  const text = normalize(raw);
  if (!text) return { ok: false, reason: "empty" };
  const nowDt = DateTime.fromJSDate(now, { zone: TZ() });

  const rel = parseRelative(text, nowDt);
  if (rel) return { ok: true, at: rel.set({ second: 0, millisecond: 0 }).toJSDate(), relative: true };

  const datePart = parseDatePart(text, nowDt);
  if (datePart?.invalid) return { ok: false, reason: "invalid" };
  const timeText = (datePart ? datePart.rest : text).trim();

  let tod = null;
  if (timeText) {
    tod = parseTimeOfDay(timeText);
    if (!tod) return { ok: false, reason: "invalid" };
  } else if (!datePart) {
    return { ok: false, reason: "invalid" };
  } else {
    tod = parseTimeOfDay(cfg?.defaultTime || "09:00");
  }

  let at = (datePart ? datePart.date : nowDt.startOf("day")).set({
    hour: tod.hour,
    minute: tod.minute,
    second: 0,
    millisecond: 0,
  });

  if (at <= nowDt) {
    // 沒寫日期 → 明天；只寫月日 → 明年；寫「週五」→ 下週五。其餘（寫死年份、今天、下週X）算過去。
    if (!datePart) at = at.plus({ days: 1 });
    else if (datePart.yearless) at = at.plus({ years: 1 });
    else if (datePart.weekday) at = at.plus({ weeks: 1 });
    else return { ok: false, reason: "past", at: at.toJSDate() };
  }
  return { ok: true, at: at.toJSDate() };
}

module.exports = { parseWhen, parseTimeOfDay, TZ };
