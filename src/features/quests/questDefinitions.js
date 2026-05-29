const { questSystem } = require("../../config");
const eventEngine = require("../event/eventEngine");

const dailyQuests = () => questSystem?.daily || [];
const weeklyQuests = () => questSystem?.weekly || [];
// 限時活動限定任務（Phase S5）：僅取生效中活動，period 已標成 `evt-<id>`。
const eventQuests = () => eventEngine.getEventQuests();

const allQuests = () => [
  ...dailyQuests().map((q) => ({ ...q, period: "daily" })),
  ...weeklyQuests().map((q) => ({ ...q, period: "weekly" })),
  ...eventQuests(),
];

const getQuestById = (id) => {
  for (const q of dailyQuests()) {
    if (q.id === id) return { ...q, period: "daily" };
  }
  for (const q of weeklyQuests()) {
    if (q.id === id) return { ...q, period: "weekly" };
  }
  const ev = eventEngine.getEventQuestById(id);
  if (ev) return ev; // 已帶 period: `evt-<id>`
  return null;
};

const isEnabled = () => questSystem?.enabled !== false;

module.exports = {
  dailyQuests,
  weeklyQuests,
  eventQuests,
  allQuests,
  getQuestById,
  isEnabled,
};
