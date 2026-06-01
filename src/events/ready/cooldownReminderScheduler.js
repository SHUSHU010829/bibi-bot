// 打工 / 挖礦到點通知掃描器：每分鐘掃一次到期未通知的訂閱並 DM 提醒。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");

const { work, mining, dungeon } = require("../../config");
const reminder = require("../../features/reminders/cooldownReminderService");

module.exports = (client) => {
  // 三個系統都沒開就不需要這個排程
  if (!work?.enabled && !mining?.enabled && !dungeon?.enabled) return;

  registerCron(client, {
    name: "reminders.cooldown",
    label: "打工/挖礦到點通知",
    schedule: "* * * * *",
    runner: () => reminder.scanAndNotify(client),
  });
};
