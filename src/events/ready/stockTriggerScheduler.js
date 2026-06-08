// 股票停損 / 停利掃描器
// 開盤時段（09:00–21:00 Asia/Taipei）每分鐘掃一次，命中即自動全倉賣出 + DM 通知。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { stockSystem } = require("../../config");
const triggerService = require("../../features/stock/triggerService");

module.exports = (client) => {
  if (!stockSystem?.enabled) return;
  registerCron(client, {
    name: "stock.trigger",
    label: "股票停損 / 停利監視",
    schedule: "* 9-20 * * *",
    timezone: "Asia/Taipei",
    runner: async () => {
      const result = await triggerService.runScan(client);
      if (result.triggered > 0) {
        console.log(
          `[CRON] stock.trigger: scanned=${result.scanned}, triggered=${result.triggered}`.cyan,
        );
      }
      return result;
    },
  });
};
