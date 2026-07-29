const { MessageFlags } = require("discord.js");

const {
  fetchThreadsData,
  extractThreadsUrl,
  circuitOpen,
  recordFailure,
  recordSuccess,
} = require("../../features/threads/threadsScraper");
const { buildThreadsPreview } = require("../../features/threads/threadsPreview");

// ============================================================
// Threads Embed Handler - 支援 Carousel 多圖 + 影片
// 抓取解析在 features/threads/threadsScraper.js、預覽組版在 threadsPreview.js
// （與 /脆 指令共用）
// ============================================================

// 主要 handler
module.exports = async (client, message) => {
  if (message.author.bot) return;

  const threadsUrl = extractThreadsUrl(message.content);
  if (!threadsUrl) return;

  if (circuitOpen()) return;

  try {
    const { data, reachable, canonicalUrl } = await fetchThreadsData(threadsUrl);
    if (!data) {
      // 只有真的連不上才算進熔斷；頁面拿到但這篇無公開資料（gate 掉）不算，
      // 否則會害正常貼文一起被暫停。此時不 suppressEmbeds，保留 Discord 原生預覽。
      if (!reachable) recordFailure();
      return;
    }
    recordSuccess();

    const container = buildThreadsPreview(data, canonicalUrl);

    // 隱藏原始 embed
    await message.suppressEmbeds(true);

    await message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.log(`[ERROR] Threads link handler 發生錯誤：\n${error}`);
  }
};
