require("colors");

const { MessageFlags } = require("discord.js");

const { registerCron } = require("../../utils/cronRegistry");
const { countdown: cfg } = require("../../config");
const countdownService = require("../../features/countdown/countdownService");
const { buildAnnouncementContainer } = require("../../features/countdown/countdownView");

async function markDone(client, doc, due) {
  if (due.kind === "arrival") {
    await client.countdownsCollection.updateOne(
      { _id: doc._id },
      { $set: { finished: true, finishedAt: new Date() } },
    );
  } else {
    await client.countdownsCollection.updateOne(
      { _id: doc._id },
      { $addToSet: { announced: due.days } },
    );
  }
}

async function runCheck(client) {
  const col = client.countdownsCollection;
  if (!col) return { skipped: "no_db" };

  const docs = await col.find({ finished: false }).sort({ targetAt: 1 }).toArray();
  let posted = 0;

  for (const doc of docs) {
    const due = countdownService.dueAnnouncement(doc);
    if (!due) continue;

    const channel = await client.channels.fetch(doc.channelId).catch(() => null);
    if (channel?.isTextBased?.()) {
      await channel
        .send({
          components: [buildAnnouncementContainer(doc, due.kind, due.days)],
          flags: MessageFlags.IsComponentsV2,
        })
        .then(() => (posted += 1))
        .catch((e) =>
          console.log(`[COUNTDOWN] 播報失敗 ${doc._id}：${e?.message || e}`.yellow),
        );
    }
    // 頻道不存在也標記，避免每天對死頻道重試。
    await markDone(client, doc, due).catch((e) =>
      console.log(`[COUNTDOWN] 更新狀態失敗 ${doc._id}：${e?.message || e}`.yellow),
    );
  }

  return { posted, scanned: docs.length };
}

module.exports = async (client) => {
  if (!cfg?.enabled) {
    console.log(`[COUNTDOWN] 倒數提醒未啟用，跳過排程`.gray);
    return;
  }
  registerCron(client, {
    name: "countdown.dailyCheck",
    label: "日期倒數里程碑播報",
    schedule: cfg.checkCron || "0 9 * * *",
    timezone: countdownService.TZ(),
    runner: () => runCheck(client),
  });
};

module.exports.runCheck = runCheck;
