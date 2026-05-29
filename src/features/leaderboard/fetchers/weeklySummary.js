const weeklySummary = require("../weeklySummary");

// 週報複合榜：挖礦數量 / 礦石市值 / 稱號收藏 各 Top 3，回傳 sections 給 render。
async function fetchWeeklySummary(client, { guildId }) {
  const { sections, footer } = await weeklySummary.sections(client, guildId, 3);
  return { sections, footer };
}

module.exports = fetchWeeklySummary;
