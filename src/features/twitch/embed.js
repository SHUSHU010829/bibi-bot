const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const TWITCH_PURPLE = 0x9146ff;

const formatNumber = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US");
};

const buildThumbnailUrl = (template, { width = 640, height = 360 } = {}) => {
  if (!template) return null;
  const url = template
    .replace("{width}", String(width))
    .replace("{height}", String(height));
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${Date.now()}`;
};

/**
 * 組出開台通知（傳統 Embed + Watch Stream 按鈕）。
 * 回傳 { embed, row, channelUrl }。
 */
const buildLiveStreamMessage = ({ stream, user } = {}) => {
  const login = (user?.login || stream?.user_login || "").toLowerCase();
  const displayName = user?.display_name || stream?.user_name || login;
  const channelUrl = `https://www.twitch.tv/${login}`;

  const title = stream?.title?.trim() || "（無標題）";
  const game = stream?.game_name?.trim() || "未分類";
  const viewers = formatNumber(stream?.viewer_count ?? 0);
  const startedAt = stream?.started_at
    ? new Date(stream.started_at)
    : new Date();

  const safeTitle = title.slice(0, 256);

  const embed = new EmbedBuilder()
    .setColor(TWITCH_PURPLE)
    .setAuthor({ name: `${displayName} is now live on Twitch!`, url: channelUrl })
    .setTitle(safeTitle)
    .setURL(channelUrl)
    .addFields(
      { name: "Game", value: game.slice(0, 1024), inline: true },
      { name: "Viewers", value: viewers, inline: true },
    )
    .setFooter({ text: `twitch.tv/${login}` })
    .setTimestamp(startedAt);

  const thumb = buildThumbnailUrl(stream?.thumbnail_url);
  if (thumb) embed.setImage(thumb);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel("Watch Stream")
      .setURL(channelUrl),
  );

  return { embed, row, channelUrl };
};

module.exports = { buildLiveStreamMessage, TWITCH_PURPLE };
