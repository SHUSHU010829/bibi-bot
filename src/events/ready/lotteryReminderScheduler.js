// 樂透期中提醒 cron 掃描器,每小時整點掃一次。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const { processReminders } = require("../../features/casino/lottery/reminderAnnouncer");

module.exports = (client) => {
  const cfg = casino?.lottery;
  if (!cfg?.enabled) return;
  if (cfg.reminders?.enabled === false) return;

  registerCron(client, {
    name: "lottery.reminder",
    label: "樂透期中提醒",
    schedule: cfg.reminderCron || "0 * * * *",
    timezone: cfg.timezone || "Asia/Taipei",
    runner: () => processReminders(client),
  });
};
