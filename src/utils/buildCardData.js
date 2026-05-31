const WEEKDAY_EN = ["", "MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * 把當日資料打包成 generateMorningCard 需要的格式。
 */
function buildCardData({
  now,
  lunarInfo,
  strawResult,
  nextSpecialDay,
  daysUntilSpecialDay,
  diamondCount,
}) {
  const dateStr = `${now.toFormat("yyyy.MM.dd")} ${WEEKDAY_EN[now.weekday] || ""}`.trim();

  const lunarYearLabel = lunarInfo
    ? `${(lunarInfo.lunarYear || "").replace("年", "")}${lunarInfo.zodiac || ""}年`
    : "";
  const lunarDay = lunarInfo
    ? `${lunarInfo.lunarMonth || ""}${lunarInfo.lunarDay || ""}`
    : "";

  const fortuneText = (strawResult || "").replace(/^\S+\s+/, "").trim();

  return {
    dateStr,
    lunarYearLabel,
    lunarDay,
    countdownName: nextSpecialDay ? nextSpecialDay.description : null,
    countdownDays: daysUntilSpecialDay || null,
    fortuneText,
    recommends: lunarInfo?.recommends || [],
    avoids: lunarInfo?.avoids || [],
    diamondCount: diamondCount || 0,
    serialNo: "0829",
  };
}

module.exports = buildCardData;
