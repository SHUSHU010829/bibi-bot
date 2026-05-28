const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");

const TWITCH_PURPLE = 0x9146ff;

const formatNumber = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
};

const buildThumbnailUrl = (template, { width = 640, height = 360 } = {}) => {
  if (!template) return null;
  // 加上 cache-buster 避免 Discord 把舊縮圖快取住
  const url = template
    .replace("{width}", String(width))
    .replace("{height}", String(height));
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
};

/**
 * 組出開台通知 Container（含 Watch Stream 按鈕）。
 * 回傳 { container, channelUrl }；caller 自行決定要不要附通知文（以 TextDisplay 形式塞進首段）。
 */
const buildLiveStreamContainer = ({ stream, user, header = "" } = {}) => {
  const login = (user?.login || stream?.user_login || "").toLowerCase();
  const displayName = user?.display_name || stream?.user_name || login;
  const channelUrl = `https://www.twitch.tv/${login}`;

  const title = stream?.title?.trim() || "（無標題）";
  const game = stream?.game_name?.trim() || "未分類";
  const viewers = formatNumber(stream?.viewer_count ?? 0);
  const startedAt = stream?.started_at
    ? Math.floor(new Date(stream.started_at).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const headerLine = header ? `${header}\n` : "";
  const safeTitle = title.slice(0, 256);

  const container = new ContainerBuilder()
    .setAccentColor(TWITCH_PURPLE)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `${headerLine}-# [${displayName}](${channelUrl}) is now live on Twitch!\n# [${safeTitle}](${channelUrl})`,
      ),
    );

  const thumb = buildThumbnailUrl(stream?.thumbnail_url);
  if (thumb) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(thumb).setDescription(safeTitle),
      ),
    );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Game**：${game.slice(0, 1024)}\n` +
          `**Viewers**：${viewers}\n` +
          `**開台**：<t:${startedAt}:R>`,
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Watch Stream")
          .setURL(channelUrl),
      ),
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# twitch.tv/${login}`),
    );

  return { container, channelUrl };
};

module.exports = { buildLiveStreamContainer, TWITCH_PURPLE };
