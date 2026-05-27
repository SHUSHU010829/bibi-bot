const { EmbedBuilder } = require("discord.js");
const { DateTime } = require("luxon");

const { buildStoreUrl } = require("./steam");
const { NEWSPAPER_EMOJI } = require("../../constants/emoji");

const COLOR_DEAL = 0xff6b35;
const COLOR_LOWEST = 0xe63946;

const truncate = (text, max) => {
  if (!text) return "";
  const stripped = text.replace(/\s+/g, " ").trim();
  if (stripped.length <= max) return stripped;
  return stripped.slice(0, max - 1) + "…";
};

const formatRemaining = (endTime) => {
  if (!endTime) return null;
  const end = DateTime.fromSeconds(endTime, { zone: "Asia/Taipei" });
  const now = DateTime.now().setZone("Asia/Taipei");
  const days = end.diff(now, "days").days;
  if (!Number.isFinite(days) || days <= 0) return null;
  if (days < 1) {
    const hours = Math.max(1, Math.ceil(end.diff(now, "hours").hours));
    return `剩餘 ${hours} 小時`;
  }
  return `剩餘 ${Math.ceil(days)} 天`;
};

const buildDealEmbed = ({ xhh, steam }) => {
  const price = steam.price_overview || {};
  const discount = price.discount_percent || 0;
  const finalFmt = price.final_formatted || "";
  const initialFmt = price.initial_formatted || "";
  const isLowest = xhh.isLowest || xhh.newLowest;

  const summaryParts = [];
  if (finalFmt) summaryParts.push(`**${finalFmt}**`);
  if (initialFmt && initialFmt !== finalFmt) summaryParts.push(`~~${initialFmt}~~`);
  if (discount > 0) summaryParts.push(`-${discount}%`);

  let authorLabel = "限時特價";
  if (xhh.newLowest) authorLabel = "新史低特價";
  else if (xhh.isLowest) authorLabel = "史低特價";

  const embed = new EmbedBuilder()
    .setAuthor({ name: authorLabel })
    .setTitle(steam.name || xhh.rawName || `App ${xhh.appid}`)
    .setURL(buildStoreUrl(xhh.appid))
    .setColor(isLowest ? COLOR_LOWEST : COLOR_DEAL)
    .setTimestamp(new Date())
    .setFooter({ text: "來源:小黑盒 + Steam" });

  embed.setDescription(
    summaryParts.length > 0
      ? `${NEWSPAPER_EMOJI} ${summaryParts.join("  ·  ")}`
      : NEWSPAPER_EMOJI
  );

  if (steam.header_image) embed.setImage(steam.header_image);

  embed.addFields({ name: "平台", value: "Steam", inline: true });

  if (typeof xhh.score === "number" && xhh.score > 0) {
    embed.addFields({
      name: "評分",
      value: xhh.score.toFixed(1),
      inline: true,
    });
  }

  const remaining = formatRemaining(xhh.endTime);
  if (remaining) {
    embed.addFields({ name: "截止", value: remaining, inline: true });
  }

  if (steam.short_description) {
    embed.addFields({
      name: "簡介",
      value: truncate(steam.short_description, 100),
    });
  }

  return embed;
};

module.exports = { buildDealEmbed };
