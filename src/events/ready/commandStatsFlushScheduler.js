require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { flush, pendingSize } = require("../../utils/commandUsageTracker");

let exitHookInstalled = false;

module.exports = async (client) => {
  registerCron(client, {
    name: "commandStats.flush",
    label: "指令使用量 每 10 分鐘 flush",
    schedule: "*/10 * * * *",
    timezone: "Asia/Taipei",
    runner: async () => {
      const res = await flush(client);
      return res;
    },
  });

  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // SIGINT/SIGTERM 收到後盡力 flush 一次；用 process.once 避免重複註冊。
    // 若其他 handler 直接呼叫 process.exit() 而沒等 Promise，這次寫入會掉，
    // 但下一輪 cron 仍會把後續累積寫進去，所以不致命。
    const handler = async () => {
      if (pendingSize() === 0) return;
      try {
        await flush(client);
      } catch (err) {
        console.log(`[CMD-STATS] exit flush 失敗：${err.message}`.yellow);
      }
    };
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  }
};
