require("colors");

const cron = require("node-cron");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
} = require("discord.js");

const eventEngine = require("../../features/event/eventEngine");

// Phase S5 — 限時活動排程：每分鐘掃描設定檔，活動開始 / 結束時發一次公告。
//
// 去重：靠 EventAnnouncements 的 (eventId, phase, occurrence) unique index，
// occurrence 取該次視窗的開始 / 結束 epoch，使同一活動明年再跑視為不同實例。
// 結束公告設寬限窗（announceEndGraceMinutes），避免首次部署時把很久以前
// 結束的歷史活動也補一則公告。

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;

const COLORS = { start: 0x9b59b6, end: 0x95a5a6 };

function resolveChannelId(event) {
  return event.announceChannelId || eventEngine.cfg().announceChannelId || "";
}

// 嘗試標記某活動某階段已公告；回傳 true 表示「這次才標到（可以發）」。
async function claimAnnouncement(client, eventId, phase, occurrence) {
  const col = client.eventAnnouncementsCollection;
  if (!col) return false; // 無 DB 不發，避免重複轟炸
  try {
    await col.insertOne({
      eventId,
      phase,
      occurrence,
      createdAt: new Date(),
    });
    return true;
  } catch (e) {
    if (e?.code === 11000) return false; // 已公告過
    console.log(`[EVENT] 公告去重寫入失敗 ${eventId}/${phase}: ${e.message}`.yellow);
    return false;
  }
}

async function sendAnnouncement(client, event, phase) {
  const channelId = resolveChannelId(event);
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;

  const isStart = phase === "start";
  const title = isStart
    ? `# 🎉 限時活動開始：${event.name}`
    : `# 🏁 活動結束：${event.name}`;
  const body = isStart
    ? event.announcementText || event.description || "活動開始囉！"
    : `感謝參與 **${event.name}**，本次活動已結束，限定加成與掉落已停止。`;

  const container = new ContainerBuilder()
    .setAccentColor(COLORS[phase] || 0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# <t:${Math.floor(Date.now() / 1000)}:R>　用 /加成 查看生效中的加成`,
      ),
    );

  await channel
    .send({ components: [container], flags: MessageFlags.IsComponentsV2 })
    .catch((e) => console.log(`[EVENT] 公告發送失敗 ${event.id}/${phase}: ${e.message}`.yellow));
  return true;
}

async function announceOnce(client, event, phase, occurrence) {
  const claimed = await claimAnnouncement(client, event.id, phase, occurrence);
  if (!claimed) return;
  await sendAnnouncement(client, event, phase);
  console.log(`[EVENT] 已公告 ${event.id} ${phase}`.cyan);
}

async function scanOnce(client) {
  if (!eventEngine.isSystemEnabled()) return;
  const now = Date.now();
  const graceMs = (eventEngine.cfg().announceEndGraceMinutes || 360) * 60 * 1000;

  for (const event of eventEngine.allEvents()) {
    if (event.enabled === false) continue;
    const { startMs, endMs } = eventEngine.eventWindow(event);
    if (startMs == null || endMs == null) continue;

    // 開始公告：進入生效視窗即發（去重保證一次）
    if (now >= startMs && now < endMs) {
      await announceOnce(client, event, "start", startMs);
    }
    // 結束公告：剛結束、且在寬限窗內才發（避免補發歷史活動）
    if (now >= endMs && now - endMs < graceMs) {
      await announceOnce(client, event, "end", endMs);
    }
  }
}

module.exports = async (client) => {
  if (task) return;
  if (!eventEngine.isSystemEnabled()) {
    console.log(`[EVENT] 限時活動系統未啟用，跳過排程`.gray);
    return;
  }

  const schedule = eventEngine.cfg().scanCronSchedule || "* * * * *";
  const tz = eventEngine.timezone();

  task = cron.schedule(
    schedule,
    async () => {
      try {
        await scanOnce(client);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.log(
          `[ERROR] eventScheduler failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err?.stack || err}`.red,
        );
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.log(`[ERROR] 連續錯誤過多，停止限時活動 cron`.red);
          task.stop();
        }
      }
    },
    { timezone: tz },
  );

  console.log(`[EVENT] 限時活動排程已啟動：${schedule} (${tz})`.cyan);
};

module.exports.scanOnce = scanOnce;
module.exports.sendAnnouncement = sendAnnouncement;
