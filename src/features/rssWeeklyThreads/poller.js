require("colors");
const axios = require("axios");
const pLimit = require("p-limit");
const {
  AttachmentBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");

const { rssWeeklySchedule } = require("../../config");
const { fetchFeedItems } = require("../../services/rssFeedService");
const { parseDateRange } = require("./dateRange");
const { weekWindowsFor, nextWeekWindow } = require("./weekWindow");
const { getOrCreateWeeklyThread } = require("./threadManager");

const MAX_IMAGES_PER_POST = 4;

const buildFeedUrl = (feed) => {
  const base = process.env.RSSHUB_BASE_URL || rssWeeklySchedule.rsshubBase;
  const route = rssWeeklySchedule.twitterRoute.replace("{handle}", feed.handle);
  const query = rssWeeklySchedule.twitterQuery
    ? `?${rssWeeklySchedule.twitterQuery}`
    : "";
  return `${base.replace(/\/$/, "")}${route}${query}`;
};

const isItemTooOld = (item) => {
  const maxAgeHours = rssWeeklySchedule.maxItemAgeHours;
  if (!maxAgeHours || maxAgeHours <= 0) return false;
  if (!item.pubDate) return false;
  const ts = new Date(item.pubDate).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts > maxAgeHours * 60 * 60 * 1000;
};

const itemKey = (item) => item.guid || item.link || item.title || "";

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
    console.log(`[WARN] 周表圖片下載失敗 ${url}: ${err.message}`.yellow);
    return null;
  }
};

const buildPostMessage = async ({ item, feed }) => {
  const files = [];
  const images = (item.images || []).slice(0, MAX_IMAGES_PER_POST);

  const container = new ContainerBuilder().setAccentColor(0x5865f2);

  if (images.length > 0) {
    const gallery = new MediaGalleryBuilder();
    for (let i = 0; i < images.length; i++) {
      const url = images[i];
      const ext = (url.match(/\.(jpe?g|png|gif|webp)/i)?.[1] || "jpg").toLowerCase();
      const filename = `weekly_${feed.id}_${Date.now()}_${i}.${ext}`;
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
    container.addMediaGalleryComponents(gallery);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent("（原貼文無圖）"),
    );
  }

  return { container, files };
};

const keywordRegex = () => new RegExp(rssWeeklySchedule.keywordPattern || "(周|週|課)表");

const matchesKeyword = (item) => {
  const re = keywordRegex();
  return re.test(item.textContent || "") || re.test(item.title || "");
};

const recordedAlready = async (client, feedId, key, threadId) => {
  if (!client.rssWeeklyPostsCollection) return false;
  const doc = await client.rssWeeklyPostsCollection.findOne({
    feedId,
    itemKey: key,
    threadId,
  });
  return !!doc;
};

const recordPost = async (client, payload) => {
  if (!client.rssWeeklyPostsCollection) return;
  try {
    await client.rssWeeklyPostsCollection.insertOne(payload);
  } catch (err) {
    if (err.code !== 11000) {
      console.log(`[WARN] 周表 dedup 寫入失敗 ${err.message}`.yellow);
    }
  }
};

const processFeed = async (client, feed) => {
  const channel = client.channels.cache.get(rssWeeklySchedule.channelId);
  if (!channel) {
    console.log(
      `[ERROR] 周表 RSS: 找不到頻道 ${rssWeeklySchedule.channelId}`.red,
    );
    return;
  }

  const url = buildFeedUrl(feed);
  let items;
  try {
    items = await fetchFeedItems(url);
  } catch (err) {
    console.log(`[WARN] 周表 RSS(${feed.id}) 抓取失敗: ${err.message}`.yellow);
    return;
  }
  if (!items?.length) return;

  for (const item of items) {
    if (isItemTooOld(item)) continue;
    if (!matchesKeyword(item)) continue;

    const text = `${item.title || ""}\n${item.textContent || ""}`;
    const range = parseDateRange(text, item.pubDate, rssWeeklySchedule.timezone);
    if (!range) continue;

    const windows = weekWindowsFor(range, rssWeeklySchedule.timezone);
    if (!windows.length) continue;

    const key = itemKey(item);

    for (const win of windows) {
      const thread = await getOrCreateWeeklyThread(channel, win, {
        autoArchiveMinutes: rssWeeklySchedule.threadAutoArchiveMinutes,
        reason: `周表自動建立 (${feed.id})`,
      });
      if (!thread) continue;

      if (await recordedAlready(client, feed.id, key, thread.id)) continue;

      try {
        const { container, files } = await buildPostMessage({ item, feed });
        await thread.send({
          components: [container],
          files,
          flags: MessageFlags.IsComponentsV2,
        });
        await recordPost(client, {
          feedId: feed.id,
          itemKey: key,
          itemGuid: item.guid || null,
          sourceUrl: item.link || null,
          threadId: thread.id,
          weekStart: win.start,
          postedAt: new Date(),
        });
        console.log(
          `[WEEKLY] ${feed.id} → ${win.label} 已貼 (${item.images?.length || 0} 張)`.cyan,
        );
      } catch (err) {
        console.log(
          `[ERROR] 周表貼文失敗 feed=${feed.id} thread=${win.label}: ${err.message}`.red,
        );
      }
    }
  }
};

const runWeeklyPoll = async (client) => {
  const feeds = rssWeeklySchedule.feeds || [];
  if (!feeds.length) return { processed: 0 };
  const limit = pLimit(rssWeeklySchedule.concurrency || 3);
  await Promise.all(
    feeds.map((feed) =>
      limit(() =>
        processFeed(client, feed).catch((err) =>
          console.log(`[ERROR] 周表 feed(${feed.id}) 例外: ${err.message}`.red),
        ),
      ),
    ),
  );
  return { processed: feeds.length };
};

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

module.exports = { runWeeklyPoll, ensureUpcomingWeeklyThread, buildFeedUrl };
