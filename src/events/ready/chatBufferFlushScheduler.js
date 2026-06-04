require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { coinSystem } = require("../../config");
const { flushAllBuffers } = require("../../features/economy/chatRewardBuffer");

// 每日 00:05 強制 flush 所有聊天 buffer，避免跨日 buffer 卡在低於 threshold 而沒入帳。
// 預設啟用；可由 coinSystem.chatBuffer.flushCron / timezone 覆寫排程。

module.exports = async (client) => {
  if (!coinSystem?.enabled) return;
  if (coinSystem?.chatBuffer?.enabled === false) return;

  const schedule = coinSystem?.chatBuffer?.flushCron || "5 0 * * *";
  const timezone = coinSystem?.chatBuffer?.timezone || "Asia/Taipei";

  registerCron(client, {
    name: "chatBuffer.flushAll",
    label: "聊天獎勵 buffer 每日強制 flush",
    schedule,
    timezone,
    runner: async () => {
      const res = await flushAllBuffers(client).catch((e) => {
        console.log(`[CHAT-BUFFER] flushAll cron 失敗: ${e}`.red);
        return { flushed: 0, total: 0 };
      });
      if (res.flushed > 0) {
        console.log(
          `[CHAT-BUFFER] cron flush ${res.flushed} 位玩家，共 ${res.total.toLocaleString()} 幣`.gray,
        );
      }
      return res;
    },
  });
};
