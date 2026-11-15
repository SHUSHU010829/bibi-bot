require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { reminder: cfg } = require("../../config");
const service = require("../../features/reminder/reminderService");
const notifier = require("../../features/reminder/reminderNotifier");
const { TZ } = require("../../features/reminder/timeParser");

async function runTick(client, now = new Date()) {
  if (!client.reminderJobsCollection) return { skipped: "no_db" };

  const jobs = await service.listDueJobs(client, now);
  let delivered = 0;

  for (const job of jobs) {
    // 先領取（原子刪除）再發送：私訊失敗也不會每分鐘重試同一則。
    const result = await service.processJob(client, job, now).catch((e) => {
      console.log(`[REMINDER] 任務處理失敗 ${job._id}：${e?.message || e}`.yellow);
      return null;
    });
    if (!result) continue;

    if (result.type === "deliver") {
      if (await notifier.sendDelivery(client, result)) delivered += 1;
    } else if (result.type === "advanced" && result.reminder.kind === service.KIND_GROUP) {
      await notifier.announceGroup(client, result.reminder, result.previousDueAt);
      await notifier.refreshGroupMessage(client, result.reminder, result.ended ? "ended" : "active");
    }
  }

  return { delivered, scanned: jobs.length };
}

module.exports = async (client) => {
  if (!cfg?.enabled) {
    console.log(`[REMINDER] 提醒事項未啟用，跳過排程`.gray);
    return;
  }
  registerCron(client, {
    name: "reminder.tick",
    label: "提醒事項（私訊 / 揪團）",
    schedule: cfg.tickCron || "* * * * *",
    timezone: TZ(),
    runner: () => runTick(client),
    maxConsecutiveErrors: Infinity,
  });
};

module.exports.runTick = runTick;
