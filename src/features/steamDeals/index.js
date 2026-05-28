require("colors");
const { DateTime } = require("luxon");

const { MessageFlags } = require("discord.js");

const { fetchDiscountList } = require("./xiaoheihe");
const { fetchAppDetailsBatch } = require("./steam");
const { shouldPush } = require("./filter");
const { isAlreadyPushed, markPushed, ensureIndexes } = require("./dedupe");
const { buildDealContainer } = require("./embed");

/**
 * Run one full pass of the steam-deals job.
 *
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {string} opts.channelId
 * @param {object} opts.config  - feature config block from config.json
 * @param {boolean} [opts.dryRun]
 */
const runSteamDealsJob = async ({ client, channelId, config, dryRun = false }) => {
  const startedAt = Date.now();
  const stats = { fetched: 0, filtered: 0, deduped: 0, pushed: 0, errors: 0 };

  const channel = dryRun ? null : client.channels.cache.get(channelId);
  if (!dryRun && !channel) {
    console.log(`[ERROR] Steam特價推播：找不到頻道 ${channelId}`.red);
    return stats;
  }

  // Quiet hours check (Taipei timezone)
  const tz = config.timezone || "Asia/Taipei";
  if (config.activeHours) {
    const now = DateTime.now().setZone(tz);
    const { startHour = 9, endHour = 24 } = config.activeHours;
    const hour = now.hour;
    const inWindow =
      startHour <= endHour
        ? hour >= startHour && hour < endHour
        : hour >= startHour || hour < endHour;
    if (!inWindow) {
      console.log(
        `[INFO] Steam特價推播：當前 ${hour} 時不在推播時段 ${startHour}-${endHour}，跳過`
          .gray
      );
      return stats;
    }
  }

  const feedUrl = process.env.XIAOHEIHE_FEED_URL || config.feedUrl;
  let games;
  try {
    games = await fetchDiscountList({ feedUrl });
    stats.fetched = games.length;
  } catch (error) {
    console.log(`[ERROR] 小黑盒 RSS 拉取失敗：${error.message}`.red);
    return stats;
  }

  if (games.length === 0) return stats;

  const collection = client.steamDealsCollection;

  const appids = games.map((g) => g.appid);
  console.log(
    `[INFO] Steam特價推播：抓到 ${appids.length} 筆,開始查 Steam 台灣區資料`
      .cyan
  );

  const intervalMs = config.steamRequestIntervalMs || 800;

  for (let i = 0; i < games.length; i++) {
    const xhh = games[i];

    let steamData = null;
    try {
      const [{ data }] = await fetchAppDetailsBatch([xhh.appid], {
        intervalMs: 0,
      });
      steamData = data;
    } catch (error) {
      stats.errors += 1;
      console.log(
        `[ERROR] Steam appdetails ${xhh.appid} 例外：${error.message}`.red
      );
    }

    if (i < games.length - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const decision = shouldPush(xhh, steamData, config.filters || {});
    if (!decision.ok) {
      stats.filtered += 1;
      continue;
    }

    const discountPercent = steamData.price_overview?.discount_percent || 0;
    const isLowest = xhh.isLowest || xhh.newLowest;

    const already = await isAlreadyPushed(collection, {
      appid: xhh.appid,
      discountPercent,
      isLowest,
    });
    if (already) {
      stats.deduped += 1;
      continue;
    }

    const container = buildDealContainer({ xhh, steam: steamData });

    if (dryRun) {
      console.log(
        `[DRY-RUN] would push appid=${xhh.appid} discount=-${discountPercent}% lowest=${isLowest}`
          .yellow
      );
      stats.pushed += 1;
      continue;
    }

    try {
      await channel.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
      });
      stats.pushed += 1;
      await markPushed(collection, {
        appid: xhh.appid,
        discountPercent,
        isLowest,
      });
    } catch (error) {
      stats.errors += 1;
      console.log(
        `[ERROR] Discord 推播失敗 appid=${xhh.appid}：${error.message}`.red
      );
      // 注意:不寫入 dedupe,讓下次重試
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[INFO] Steam特價推播完成 (${elapsed}s) fetched=${stats.fetched} filtered=${stats.filtered} deduped=${stats.deduped} pushed=${stats.pushed} errors=${stats.errors}`
      .cyan
  );

  return stats;
};

module.exports = { runSteamDealsJob, ensureIndexes };
