require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { questSystem } = require("../../config");
const questService = require("../../features/quests/questService");

// 每天 23:50 Asia/Taipei 把所有「completed 但忘了領」的當日任務 fallback claim 一次，
// 避免跨期 reset 後獎勵直接消失。週常的 ready 也會一併被結算（因為 claimAll 不分 tier）。
module.exports = async (client) => {
  if (!questSystem?.enabled) return;

  registerCron(client, {
    name: "quest.autoFlush",
    label: "任務每日 23:50 自動結算未領",
    schedule: "50 23 * * *",
    timezone: questSystem?.resetTimezone || "Asia/Taipei",
    runner: async () => {
      const res = await questService.autoFlushAllReady(client).catch((e) => {
        console.log(`[QUEST] autoFlush cron 失敗: ${e}`.red);
        return { users: 0, total: 0 };
      });
      if (res.users > 0) {
        console.log(
          `[QUEST] 23:50 autoFlush ${res.users} 位玩家，共 ${res.total.toLocaleString()} 幣`.gray,
        );
      }
      return res;
    },
  });
};
