require("colors");
const { DateTime } = require("luxon");

const { fetchFreeGamesList } = require("./gamerpower");
const { fetchAppDetails } = require("../steamDeals/steam");
const { isAlreadyPushed, markPushed, ensureIndexes } = require("./dedupe");
const { buildFreeGameEmbed } = require("./embed");

const isInActiveHours = (cfg) => {
  if (!cfg.activeHours) return true;
  const tz = cfg.timezone || "Asia/Taipei";
  const { startHour = 9, endHour = 24 } = cfg.activeHours;
  const hour = DateTime.now().setZone(tz).hour;
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
};

/**
 * Run one pass for a single platform feed (epic | steam | gog).
 *
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {string} opts.channelId
 * @param {object} opts.config
 * @param {string} opts.platform
 * @param {string} [opts.apiUrl]  覆寫 GamerPower API base URL
 * @param {boolean} [opts.dryRun]
 */
const runFreeGamesJob = async ({
  client,
  channelId,
  config,
  platform,
  apiUrl,
  dryRun = false,
}) => {
  const startedAt = Date.now();
  const stats = { fetched: 0, deduped: 0, pushed: 0, errors: 0 };

  if (!isInActiveHours(config)) {
    console.log(
      `[INFO] 喜加一(${platform})：不在推播時段,跳過`.gray
    );
    return stats;
  }

  const channel = dryRun ? null : client.channels.cache.get(channelId);
  if (!dryRun && !channel) {
    console.log(`[ERROR] 喜加一(${platform})：找不到頻道 ${channelId}`.red);
    return stats;
  }

  let items;
  try {
    items = await fetchFreeGamesList({ apiUrl, platform });
    stats.fetched = items.length;
  } catch (error) {
    console.log(
      `[ERROR] 喜加一 API 拉取失敗 (${platform}): ${error.message}`.red
    );
    return stats;
  }

  if (items.length === 0) {
    return stats;
  }

  console.log(
    `[INFO] 喜加一(${platform})：抓到 ${items.length} 筆`.cyan
  );

  const collection = client.freeGamesCollection;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const already = await isAlreadyPushed(collection, item);
    if (already) {
      stats.deduped += 1;
      continue;
    }

    // 只有 Steam 平台才補抓 appdetails (拿台灣價、繁中名、簡介、header_image)
    let steamData = null;
    if (platform === "steam" && item.appid) {
      steamData = await fetchAppDetails(item.appid);
      // Steam 端可能還沒上架台灣區,沒關係,用 RSS 資料 fallback
    }

    const embed = buildFreeGameEmbed({ item, steamData });

    if (dryRun) {
      console.log(
        `[DRY-RUN] would push free [${platform}] appid=${item.appid} "${item.name}"`
          .yellow
      );
      stats.pushed += 1;
      continue;
    }

    try {
      await channel.send({ embeds: [embed] });
      stats.pushed += 1;
      await markPushed(collection, item);
    } catch (error) {
      stats.errors += 1;
      console.log(
        `[ERROR] 喜加一 推播失敗 [${platform}] appid=${item.appid}: ${error.message}`
          .red
      );
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[INFO] 喜加一(${platform})完成 (${elapsed}s) fetched=${stats.fetched} deduped=${stats.deduped} pushed=${stats.pushed} errors=${stats.errors}`
      .cyan
  );

  return stats;
};

module.exports = { runFreeGamesJob, ensureIndexes };
