const { reminder: cfg } = require("../../config");

function minutesText(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小時`;
  return `${minutes} 分鐘`;
}

function repeatLabel(value) {
  return (cfg?.repeatChoices || []).find((c) => c.value === value)?.name || "不重複";
}

function leadLabel(minutes) {
  if (!minutes) return "不提前";
  return (cfg?.leadChoices || []).find((c) => c.minutes === minutes)?.name || `提前 ${minutesText(minutes)}`;
}

function nagLabel(minutes, count) {
  if (!minutes) return "不追加";
  const base = (cfg?.nagChoices || []).find((c) => c.minutes === minutes)?.name || `每 ${minutesText(minutes)}`;
  return count ? `${base}，最多 ${count} 次` : base;
}

function snoozeLabel(minutes) {
  return (cfg?.snoozeChoices || []).find((c) => c.minutes === minutes)?.name || `${minutesText(minutes)}後`;
}

module.exports = { repeatLabel, leadLabel, nagLabel, snoozeLabel, minutesText };
