const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");
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

const buildDealContainer = ({ xhh, steam }) => {
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

  const title = steam.name || xhh.rawName || `App ${xhh.appid}`;
  const url = buildStoreUrl(xhh.appid);
  const summaryLine =
    summaryParts.length > 0
      ? `${NEWSPAPER_EMOJI} ${summaryParts.join("  ·  ")}`
      : NEWSPAPER_EMOJI;

  const container = new ContainerBuilder()
    .setAccentColor(isLowest ? COLOR_LOWEST : COLOR_DEAL)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${authorLabel}\n# [${title}](${url})\n${summaryLine}`,
      ),
    );

  if (steam.header_image) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(steam.header_image)
          .setDescription(title),
      ),
    );
  }

  const infoLines = [`**平台**：Steam`];
  if (typeof xhh.score === "number" && xhh.score > 0) {
    infoLines.push(`**評分**：${xhh.score.toFixed(1)}`);
  }
  const remaining = formatRemaining(xhh.endTime);
  if (remaining) infoLines.push(`**截止**：${remaining}`);

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(infoLines.join("\n")),
    );

  if (steam.short_description) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**簡介**\n${truncate(steam.short_description, 100)}`,
      ),
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 來源：小黑盒 + Steam ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
    ),
  );

  return container;
};

module.exports = { buildDealContainer };
