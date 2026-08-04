require("colors");

const { rssWeeklySchedule } = require("../../config");
const { nextWeekWindow } = require("./weekWindow");
const { getOrCreateWeeklyThread } = require("./threadManager");

const ensureUpcomingWeeklyThread = async (client) => {
  const channel = client.channels.cache.get(rssWeeklySchedule.channelId);
  if (!channel) {
    console.log(
      `[ERROR] 周表預建: 找不到頻道 ${rssWeeklySchedule.channelId}`.red,
    );
    return { created: 0 };
  }
  const win = nextWeekWindow(rssWeeklySchedule.timezone);
  const thread = await getOrCreateWeeklyThread(channel, win, {
    autoArchiveMinutes: rssWeeklySchedule.threadAutoArchiveMinutes,
    reason: "周表預建（每週五觸發）",
  });
  return { created: thread ? 1 : 0, label: win.label };
};

module.exports = { ensureUpcomingWeeklyThread };
