const fs = require("fs");
const { DateTime } = require("luxon");
const { getDataFile } = require("./dataPaths");

const CALENDAR_FILE = getDataFile("calender.json");

function loadCalenderData() {
  try {
    if (fs.existsSync(CALENDAR_FILE)) {
      return JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf8"));
    }
  } catch (error) {
    console.log(`[ERROR] 讀取 calender.json 時出錯：${error}`);
  }
  return null;
}

/**
 * 找出當日（含）之後第一個帶有 description 的日子，以及還有幾天。
 * 當天就是特殊日時，daysUntilSpecialDay 會是 0。
 *
 * @param {DateTime} now
 * @param {string} timezone
 * @returns {{ nextSpecialDay: object|null, daysUntilSpecialDay: number|null }}
 */
function findNextSpecialDay(now, timezone) {
  const searchDate = now.toFormat("yyyyMMdd");

  const calenderData = loadCalenderData();
  if (!calenderData) {
    return { nextSpecialDay: null, daysUntilSpecialDay: null };
  }

  const sortedSpecialDays = calenderData
    .filter(
      (data) =>
        data.description &&
        data.description.trim() !== "" &&
        data.date >= searchDate
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sortedSpecialDays.length === 0) {
    return { nextSpecialDay: null, daysUntilSpecialDay: null };
  }

  const nextSpecialDay = sortedSpecialDays[0];
  const specialDate = DateTime.fromFormat(nextSpecialDay.date, "yyyyMMdd", {
    zone: timezone,
  });
  const daysUntilSpecialDay = Math.round(
    specialDate.diff(now.startOf("day"), "days").days
  );

  return { nextSpecialDay, daysUntilSpecialDay };
}

module.exports = findNextSpecialDay;
