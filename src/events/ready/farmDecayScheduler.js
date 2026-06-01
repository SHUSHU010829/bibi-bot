// 農場 status 切換掃描器（Phase D）
// 每小時掃一次：growing→ready（到成熟時間）、ready→rotted（過保鮮期）。
//
// 即時 UI 也會在 /農場 開啟時做 live resolve（不依賴 cron），這隻 cron 主要負責
// 把 DB 裡的 status 對齊真實時間，讓 dashboard / 排行榜查詢時數字正確。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { farming } = require("../../config");
const farmService = require("../../features/farm/farmService");

module.exports = (client) => {
  if (!farming?.enabled) return;
  registerCron(client, {
    name: "farm.decay",
    label: "農場狀態掃描（成熟/枯萎）",
    schedule: "0 * * * *",
    timezone: "Asia/Taipei",
    runner: async () => {
      const result = await farmService.runDecaySweep(client);
      if (result.ready > 0 || result.rotted > 0) {
        console.log(
          `[CRON] farm.decay: ready=${result.ready}, rotted=${result.rotted}`.cyan,
        );
      }
      return result;
    },
  });
};
