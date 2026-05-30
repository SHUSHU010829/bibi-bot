// 打工 / 挖礦到點通知掃描器：每分鐘掃一次到期未通知的訂閱並 DM 提醒。

require("colors");
const cron = require("node-cron");

const { work, mining, dungeon } = require("../../config");
const reminder = require("../../features/reminders/cooldownReminderService");

module.exports = (client) => {
  // 三個系統都沒開就不需要這個排程
  if (!work?.enabled && !mining?.enabled && !dungeon?.enabled) return;

  cron.schedule("* * * * *", async () => {
    try {
      await reminder.scanAndNotify(client);
    } catch (err) {
      console.log(
        `[ERROR] cooldown reminder scheduler:\n${err}\n${err.stack}`.red
      );
    }
  });

  console.log("[SYSTEM] 打工/挖礦到點通知排程啟動：每分鐘".green);
};
