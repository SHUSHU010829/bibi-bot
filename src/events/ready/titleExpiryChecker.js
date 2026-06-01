require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const gameTitleService = require("../../features/gameTitles/gameTitleService");

// 每小時掃描已過期但仍 active 的遊戲稱號 meta，撤銷之（gameTitles 移除 + meta 標 expired）。
// 是抖內限時身分組（Phase 8）等時效稱號的共用過期機制；目前遊戲稱號預設永久（expiresAt=null）。

async function runExpiryScan(client) {
  if (!client.userLevelsCollection) return { revoked: 0 };
  const expired = await gameTitleService.findExpiredActive(client, Date.now());
  if (!expired.length) return { revoked: 0 };

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
  return { revoked: expired.length };
}

module.exports = async (client) => {
  // 每小時的第 5 分鐘執行，避開整點其他排程
  registerCron(client, {
    name: "title.expiry",
    label: "稱號到期檢查",
    schedule: "5 * * * *",
    timezone: "Asia/Taipei",
    runner: () => runExpiryScan(client),
  });
};
