require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { rssWeeklySchedule } = require("../../config");
const {
  runWeeklyPoll,
  ensureUpcomingWeeklyThread,
} = require("../../features/rssWeeklyThreads/poller");

module.exports = async (client) => {
  if (!rssWeeklySchedule?.enabled) {
    console.log(`[INFO] 周表 RSS 已停用（config.rssWeeklySchedule.enabled = false）`.gray);
    return;
  }

  if (rssWeeklySchedule.pollEnabled) {
    registerCron(client, {
      name: "rssWeeklyThreads.poll",
      label: "周表 RSS 巡檢",
      schedule: rssWeeklySchedule.pollCron,
      timezone: rssWeeklySchedule.timezone,
      runner: () => runWeeklyPoll(client),
    });
  }

  registerCron(client, {
    name: "rssWeeklyThreads.create",
    label: "周表預建討論串（每週三）",
    schedule: rssWeeklySchedule.createThreadCron,
    timezone: rssWeeklySchedule.timezone,
    runner: () => ensureUpcomingWeeklyThread(client),
  });
};
