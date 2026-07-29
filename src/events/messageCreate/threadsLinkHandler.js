const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");

const {
  fetchThreadsData,
  extractThreadsUrl,
  circuitOpen,
  recordFailure,
  recordSuccess,
} = require("../../features/threads/threadsScraper");

// ============================================================
// Threads Embed Handler - 支援 Carousel 多圖 + 影片
// 抓取 / 解析邏輯在 features/threads/threadsScraper.js（與 /脆 指令共用）
// ============================================================

// 格式化數字（1000 -> 1K）
function formatNumber(num) {
  if (!num || num < 1000) return String(num || 0);
  if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

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

    // 主頭：作者 + 文字
    const headLines = [
      `-# [@${data.username}${data.isVerified ? " ✓" : ""}](${canonicalUrl})`,
    ];
    if (data.text) {
      const desc =
        data.text.length > 400 ? data.text.slice(0, 400) + "..." : data.text;
      headLines.push(desc);
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x000000)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(headLines.join("\n")),
      );

    // 圖片牆（最多 10 張）
    if (data.images.length > 0) {
      const gallery = new MediaGalleryBuilder();
      for (let i = 0; i < Math.min(data.images.length, 10); i++) {
        gallery.addItems(new MediaGalleryItemBuilder().setURL(data.images[i]));
      }
      container.addMediaGalleryComponents(gallery);
    }

    // 互動數據與影片提示
    const stats = [];
    if (data.likeCount > 0) stats.push(`❤️ ${formatNumber(data.likeCount)}`);
    if (data.replyCount > 0) stats.push(`💬 ${formatNumber(data.replyCount)}`);
    if (data.images.length > 10) stats.push(`📷 +${data.images.length - 10} more`);
    if (data.videos.length > 0) stats.push("🎬 此貼文包含影片");
    if (stats.length > 0) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# ${stats.join("  •  ")}`),
        );
    }

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
