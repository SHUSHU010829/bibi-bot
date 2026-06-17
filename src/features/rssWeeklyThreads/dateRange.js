const { DateTime } = require("luxon");

const normalize = (raw) => {
  if (!raw) return "";
  let text = String(raw);
  text = text.normalize("NFKC");
  text = text.replace(/[～~–—－─–—]/g, "-");
  text = text.replace(/\s*(?:至|到)\s*/g, "-");
  return text;
};

const RANGE_REGEX =
  /(\d{1,2})\s*[./月\-]\s*(\d{1,2})\s*日?\s*-\s*(\d{1,2})\s*[./月\-]\s*(\d{1,2})\s*日?/;

// 後備：四碼 MMDD-MMDD（月日間無分隔符，例如「0518-0524」）。標準格式配不到時才用，
// 並用 (?<!\d)/(?!\d) 鎖定剛好四位，避免吃到年份或其他數字串。
const COMPACT_RANGE_REGEX = /(?<!\d)(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})(?!\d)/;

const matchRangeNumbers = (norm) => {
  const m = norm.match(RANGE_REGEX);
  if (m) return m.slice(1, 5).map(Number);
  const c = norm.match(COMPACT_RANGE_REGEX);
  if (c) return c.slice(1, 5).map(Number);
  return null;
};

const inferYears = (startMonth, endMonth, pubDate) => {
  const ref = pubDate ? DateTime.fromISO(new Date(pubDate).toISOString()) : DateTime.now();
  const year = ref.isValid ? ref.year : new Date().getFullYear();
  let startYear = year;
  let endYear = year;
  if (endMonth < startMonth) endYear = year + 1;
  if (ref.isValid && startMonth - ref.month > 6) {
    startYear = year - 1;
    if (endMonth < startMonth) endYear = year;
  }
  return { startYear, endYear };
};

const parseDateRange = (text, pubDate, tz = "Asia/Taipei") => {
  const norm = normalize(text);
  const nums = matchRangeNumbers(norm);
  if (!nums) return null;
  const [sm, sd, em, ed] = nums;
  if (!sm || !sd || !em || !ed) return null;
  if (sm > 12 || em > 12 || sd > 31 || ed > 31) return null;
  const { startYear, endYear } = inferYears(sm, em, pubDate);
  const start = DateTime.fromObject(
    { year: startYear, month: sm, day: sd },
    { zone: tz },
  ).startOf("day");
  const end = DateTime.fromObject(
    { year: endYear, month: em, day: ed },
    { zone: tz },
  ).endOf("day");
  if (!start.isValid || !end.isValid) return null;
  return { start: start.toJSDate(), end: end.toJSDate() };
};

module.exports = { parseDateRange, normalize };
