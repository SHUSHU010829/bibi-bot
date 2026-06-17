require("colors");
const axios = require("axios");
const {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");

const { rssWeeklySchedule } = require("../../config");
const { parseDateRange } = require("../../features/rssWeeklyThreads/dateRange");
const { weekWindowsFor } = require("../../features/rssWeeklyThreads/weekWindow");
const {
  getOrCreateWeeklyThread,
} = require("../../features/rssWeeklyThreads/threadManager");

const MAX_IMAGES = 4;

const collectImageUrls = (message) => {
  const urls = [];
  for (const att of message.attachments?.values?.() || []) {
    const isImage =
      att.contentType?.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp)(\?|$)/i.test(att.url || att.name || "");
    if (isImage && att.url) urls.push(att.url);
  }
  for (const emb of message.embeds || []) {
    const url = emb.image?.url || emb.thumbnail?.url;
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
};

const downloadImage = async (url, filename) => {
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      maxContentLength: 25 * 1024 * 1024,
    });
    return new AttachmentBuilder(Buffer.from(res.data), { name: filename });
  } catch (err) {
    console.log(`[WARN] 周表轉貼圖片下載失敗 ${url}: ${err.message}`.yellow);
    return null;
  }
};

const buildImageMessage = async (imageUrls) => {
  const files = [];
  const gallery = new MediaGalleryBuilder();
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const ext = (url.match(/\.(jpe?g|png|gif|webp)/i)?.[1] || "jpg").toLowerCase();
    const filename = `weekly_forward_${Date.now()}_${i}.${ext}`;
    const attachment = await downloadImage(url, filename);
    if (attachment) {
      files.push(attachment);
      gallery.addItems(
        new MediaGalleryItemBuilder().setURL(`attachment://${filename}`),
      );
    } else {
      gallery.addItems(new MediaGalleryItemBuilder().setURL(url));
    }
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addMediaGalleryComponents(gallery);
  return { container, files };
};

module.exports = async (client, message) => {
  const cfg = rssWeeklySchedule?.discordForward;
  if (!cfg?.enabled) return;
  if (message.channelId !== cfg.sourceChannelId) return;
  if (message.author?.id === client.user?.id) return;

  const firstLine = (message.content || "").split("\n")[0]?.trim();
  if (!firstLine) return;

  const range = parseDateRange(
    firstLine,
    message.createdAt,
    rssWeeklySchedule.timezone,
  );
  if (!range) {
    console.log(`[WEEKLY] 轉貼訊息首行無法解析日期，略過：${firstLine}`.gray);
    return;
  }

  const windows = weekWindowsFor(range, rssWeeklySchedule.timezone);
  if (!windows.length) return;

  const imageUrls = collectImageUrls(message).slice(0, MAX_IMAGES);
  if (!imageUrls.length) {
    console.log(`[WEEKLY] 轉貼週表無圖片，略過：${firstLine}`.gray);
    return;
  }

  const channel = client.channels.cache.get(rssWeeklySchedule.channelId);
  if (!channel) {
    console.log(
      `[ERROR] 周表轉貼: 找不到目標頻道 ${rssWeeklySchedule.channelId}`.red,
    );
    return;
  }

  for (const win of windows) {
    const thread = await getOrCreateWeeklyThread(channel, win, {
      autoArchiveMinutes: rssWeeklySchedule.threadAutoArchiveMinutes,
      reason: "周表自動建立（Discord 轉貼）",
    });
    if (!thread) continue;

    const dedupKey = {
      feedId: "discord_forward",
      itemKey: message.id,
      threadId: thread.id,
    };
    if (client.rssWeeklyPostsCollection) {
      const existing = await client.rssWeeklyPostsCollection.findOne(dedupKey);
      if (existing) continue;
    }

    try {
      const { container, files } = await buildImageMessage(imageUrls);
      await thread.send({
        components: [container],
        files,
        flags: MessageFlags.IsComponentsV2,
      });
      if (client.rssWeeklyPostsCollection) {
        await client.rssWeeklyPostsCollection
          .insertOne({
            ...dedupKey,
            itemGuid: null,
            sourceUrl: message.url || null,
            weekStart: win.start,
            postedAt: new Date(),
          })
          .catch((err) => {
            if (err.code !== 11000) {
              console.log(`[WARN] 周表轉貼 dedup 寫入失敗 ${err.message}`.yellow);
            }
          });
      }
      console.log(
        `[WEEKLY] Discord 轉貼 → ${win.label} 已貼 (${imageUrls.length} 張)`.cyan,
      );
    } catch (err) {
      console.log(
        `[ERROR] 周表轉貼貼文失敗 thread=${win.label}: ${err.message}`.red,
      );
    }
  }
};
