require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const config = require("../../config");
const { runTwitchLiveJob, ensureIndexes } = require("../../features/twitch");

module.exports = async (client) => {
  const cfg = config.twitch;

  if (!cfg) {
    console.log(`[WARNING] config.twitch 不存在，Twitch 開台通知未啟用`.yellow);
    return;
  }

  const enabledByEnv = process.env.TWITCH_LIVE_ENABLED !== "false";
  if (!cfg.enabled || !enabledByEnv) {
    console.log(`[INFO] Twitch 開台通知未啟用 (config.enabled=${cfg.enabled})`.gray);
    return;
  }

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.log(
      `[ERROR] Twitch 開台通知：TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET 未設定`.red
    );
    return;
  }

  const channelId =
    process.env.DISCORD_TWITCH_CHANNEL_ID || cfg.channelId;
  if (!channelId) {
    console.log(
      `[ERROR] Twitch 開台通知：DISCORD_TWITCH_CHANNEL_ID / config.twitch.channelId 未設定`
        .red
    );
    return;
  }

  // 允許用 env 覆寫要追蹤的 streamer (逗號分隔)
  const envStreamers = (process.env.TWITCH_STREAMERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const streamers = envStreamers.length > 0 ? envStreamers : cfg.streamers || [];

  if (!streamers.length) {
    console.log(`[ERROR] Twitch 開台通知：沒有設定任何 streamer`.red);
    return;
  }

  if (client.twitchLiveStateCollection) {
    await ensureIndexes(client.twitchLiveStateCollection);
  }

  const cronSchedule =
    process.env.TWITCH_LIVE_CRON || cfg.cronSchedule || "*/1 * * * *";
  const timezone = cfg.timezone || "Asia/Taipei";

  const runOnce = async () => {
    try {
      const r = await runTwitchLiveJob({
        client,
        channelId,
        config: { ...cfg, streamers },
        dryRun: process.env.TWITCH_LIVE_DRY_RUN === "true",
      });
      return r ?? null;
    } catch (error) {
      console.log(
        `[ERROR] Twitch 開台通知例外:\n${error.stack || error.message}`.red
      );
      throw error;
    }
  };

  if (process.env.TWITCH_LIVE_RUN_ON_START === "true") {
    runOnce().catch(() => {});
  }

  registerCron(client, {
    name: "twitch.liveCheck",
    label: "Twitch 上線檢查",
    schedule: cronSchedule,
    timezone,
    runner: runOnce,
  });
};
