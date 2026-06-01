require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const config = require("../../config");
const { runFreeGamesJob, ensureIndexes } = require("../../features/freeGames");

module.exports = async (client) => {
  const cfg = config.freeGames;

  if (!cfg) {
    console.log(`[WARNING] config.freeGames 不存在,喜加一推播未啟用`.yellow);
    return;
  }

  const enabledByEnv = process.env.FREE_GAMES_ENABLED !== "false";
  if (!cfg.enabled || !enabledByEnv) {
    console.log(`[INFO] 喜加一推播未啟用 (config.enabled=${cfg.enabled})`.gray);
    return;
  }

  const channelId =
    process.env.DISCORD_FREE_GAMES_CHANNEL_ID ||
    process.env.DISCORD_DEALS_CHANNEL_ID ||
    cfg.channelId;
  if (!channelId) {
    console.log(
      `[ERROR] 喜加一推播：DISCORD_FREE_GAMES_CHANNEL_ID / config.freeGames.channelId 未設定`
        .red
    );
    return;
  }

  if (client.freeGamesCollection) {
    await ensureIndexes(client.freeGamesCollection);
  }

  // 來源:GamerPower API (https://www.gamerpower.com/api-read)
  // 同一個 base URL 帶不同 platform query 即可,留 env 給未來想換 mirror
  const apiUrl = process.env.FREE_GAMES_API_URL || cfg.apiUrl || undefined;
  const platforms = [
    { platform: "epic", enabled: cfg.platforms?.epic !== false, apiUrl },
    { platform: "steam", enabled: cfg.platforms?.steam !== false, apiUrl },
  ].filter((p) => p.enabled);

  const cronSchedule =
    process.env.FREE_GAMES_CRON || cfg.cronSchedule || "30 */6 * * *";
  const timezone = cfg.timezone || "Asia/Taipei";

  const runOnce = async () => {
    const results = [];
    for (const p of platforms) {
      try {
        const r = await runFreeGamesJob({
          client,
          channelId,
          config: cfg,
          platform: p.platform,
          apiUrl: p.apiUrl,
          dryRun: process.env.FREE_GAMES_DRY_RUN === "true",
        });
        results.push({ platform: p.platform, ok: true, result: r ?? null });
      } catch (error) {
        console.log(
          `[ERROR] 喜加一 job 例外 [${p.platform}]:\n${error.stack || error.message}`
            .red
        );
        results.push({ platform: p.platform, ok: false, error: String(error.message || error) });
      }
    }
    return { platforms: results };
  };

  if (process.env.FREE_GAMES_RUN_ON_START === "true") {
    runOnce();
  }

  registerCron(client, {
    name: "freeGames.push",
    label: "Epic / Steam 免費遊戲推送",
    schedule: cronSchedule,
    timezone,
    runner: runOnce,
  });
};
