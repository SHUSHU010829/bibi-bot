const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");

// 格式化數字（1000 -> 1K）
function formatNumber(num) {
  if (!num || num < 1000) return String(num || 0);
  if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

// 貼文預覽 Container（訊息自動預覽與 /脆 指令共用同一種呈現）
function buildThreadsPreview(data, postUrl) {
  // 主頭：作者 + 文字
  const headLines = [
    `-# [@${data.username}${data.isVerified ? " ✓" : ""}](${postUrl})`,
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

  return container;
}

module.exports = { buildThreadsPreview, formatNumber };
