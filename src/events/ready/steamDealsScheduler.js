require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const config = require("../../config");
const { runSteamDealsJob, ensureIndexes } = require("../../features/steamDeals");

module.exports = async (client) => {
  const cfg = config.steamDeals;

  if (!cfg) {
    console.log(`[WARNING] config.steamDeals 不存在,Steam特價推播未啟用`.yellow);
    return;
  }

  const enabledByEnv = process.env.STEAM_DEALS_ENABLED !== "false";
  if (!cfg.enabled || !enabledByEnv) {
    console.log(`[INFO] Steam特價推播未啟用 (config.enabled=${cfg.enabled})`.gray);
    return;
  }

  const channelId = process.env.DISCORD_DEALS_CHANNEL_ID || cfg.channelId;
  if (!channelId) {
    console.log(
      `[ERROR] Steam特價推播：DISCORD_DEALS_CHANNEL_ID / config.steamDeals.channelId 未設定`
        .red
    );
    return;
  }

  if (client.steamDealsCollection) {
    await ensureIndexes(client.steamDealsCollection);
  } else {
    console.log(
      `[WARNING] steamDealsCollection 未連線,推播去重將無作用 (每次都會重推)`
        .yellow
    );
  }

  const cronSchedule =
    process.env.STEAM_DEALS_CRON || cfg.cronSchedule || "0 */2 * * *";
  const timezone = cfg.timezone || "Asia/Taipei";

  const runOnce = async () => {
    try {
      const r = await runSteamDealsJob({
        client,
        channelId,
        config: cfg,
        dryRun: process.env.STEAM_DEALS_DRY_RUN === "true",
      });
      return r ?? null;
    } catch (error) {
      console.log(
        `[ERROR] Steam特價推播 job 例外:\n${error.stack || error.message}`
          .red
      );
      throw error;
    }
  };

  if (process.env.STEAM_DEALS_RUN_ON_START === "true") {
    // 故意不 await,讓 ready 流程繼續跑
    runOnce().catch(() => {});
  }

  registerCron(client, {
    name: "steam.deals",
    label: "Steam 特價推送",
    schedule: cronSchedule,
    timezone,
    runner: runOnce,
  });
};
