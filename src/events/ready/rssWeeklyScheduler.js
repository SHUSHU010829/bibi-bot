require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { rssWeeklySchedule } = require("../../config");
const {
  ensureUpcomingWeeklyThread,
} = require("../../features/rssWeeklyThreads/threadScheduler");

module.exports = async (client) => {
  if (!rssWeeklySchedule?.enabled) {
    console.log(`[INFO] 周表討論串已停用（config.rssWeeklySchedule.enabled = false）`.gray);
    return;
  }

  registerCron(client, {
    name: "rssWeeklyThreads.create",
    label: "周表預建討論串（每週三）",
    schedule: rssWeeklySchedule.createThreadCron,
    timezone: rssWeeklySchedule.timezone,
    runner: () => ensureUpcomingWeeklyThread(client),
  });
};
