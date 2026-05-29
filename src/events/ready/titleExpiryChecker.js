require("colors");

const cron = require("node-cron");
const gameTitleService = require("../../features/gameTitles/gameTitleService");

// 每小時掃描已過期但仍 active 的遊戲稱號 meta，撤銷之（gameTitles 移除 + meta 標 expired）。
// 是抖內限時身分組（Phase 8）等時效稱號的共用過期機制；目前遊戲稱號預設永久（expiresAt=null）。

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function runExpiryScan(client) {
  if (!client.userLevelsCollection) return;
  const expired = await gameTitleService.findExpiredActive(client, Date.now());
  if (!expired.length) return;

  for (const e of expired) {
    await gameTitleService
      .revoke(client, {
        userId: e.userId,
        guildId: e.guildId,
        titleId: e.titleId,
        status: "expired",
      })
      .catch(() => {});

    // 通知本人（找不到使用者 / 關私訊則靜默）
    try {
      const user = await client.users.fetch(e.userId).catch(() => null);
      if (user) {
        await user
          .send(
            `⌛ 你的限時稱號 **${gameTitleService.label(e.titleId)}** 已到期並自動卸下。`
          )
          .catch(() => {});
      }
    } catch (_) {
      /* noop */
    }
  }

  console.log(`[TITLE] 過期稱號掃描：撤銷 ${expired.length} 個`.cyan);
}

module.exports = async (client) => {
  if (task) return;

  // 每小時的第 5 分鐘執行，避開整點其他排程
  task = cron.schedule(
    "5 * * * *",
    async () => {
      try {
        await runExpiryScan(client);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.log(
          `[ERROR] titleExpiryChecker failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(`[ERROR] 連續錯誤過多，停止稱號過期 cron`.red);
          task.stop();
        }
      }
    },
    { timezone: "Asia/Taipei" }
  );

  console.log(`[TITLE] 稱號過期掃描排程已啟動：每小時 (Asia/Taipei)`.cyan);
};
