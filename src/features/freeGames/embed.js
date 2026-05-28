const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
} = require("discord.js");
const { DateTime } = require("luxon");
const { NEWSPAPER_EMOJI } = require("../../constants/emoji");

const COLOR_FREE = 0x06a77d;
const COLOR_ALWAYS = 0x3b82f6;
const COLOR_TEMPORARY = 0xf59e0b;

const DURATION_META = {
  "Always Free": {
    label: "永久免費",
    color: COLOR_ALWAYS,
    summary: "**永久免費**",
  },
  Temporary: {
    label: "試玩週末",
    color: COLOR_TEMPORARY,
    summary: "**限時試玩** (不可保留)",
  },
};

const PLATFORM_META = {
  epic: {
    label: "Epic Games",
    fallbackUrl: () => "https://store.epicgames.com/zh-TW/free-games",
  },
  steam: {
    label: "Steam",
    fallbackUrl: (appid) =>
      appid
        ? `https://store.steampowered.com/app/${appid}/?cc=tw`
        : "https://store.steampowered.com/search/?specials=1&maxprice=free",
  },
};

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

const buildFreeGameContainer = ({ item, steamData = null }) => {
  const meta = PLATFORM_META[item.platform] || PLATFORM_META.steam;

  const displayName =
    (steamData && steamData.name) ||
    item.name ||
    (item.appid ? `App ${item.appid}` : "未知遊戲");

  const steamPrice = steamData?.price_overview;
  const originalPriceText = steamPrice?.initial_formatted || item.originalPrice || null;

  const durationMeta = DURATION_META[item.duration] || null;
  const baseLabel = item.isDlc ? "限免 DLC" : durationMeta?.label || "限時免費";
  const summaryHead = durationMeta?.summary || "**免費領取**";
  const color = durationMeta?.color || COLOR_FREE;

  const summaryParts = [summaryHead];
  if (originalPriceText) summaryParts.push(`原價 ~~${originalPriceText}~~`);

  const claimUrl = item.link || meta.fallbackUrl(item.appid);
  const title = displayName.slice(0, 256);

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# ${baseLabel}\n# [${title}](${claimUrl})\n${NEWSPAPER_EMOJI} ${summaryParts.join("  ·  ")}`,
      ),
    );

  const image = (steamData && steamData.header_image) || item.image;
  if (image) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(image).setDescription(title),
      ),
    );
  }

  const infoLines = [`**平台**：${meta.label}`];
  if (typeof item.score === "number" && item.score > 0) {
    infoLines.push(`**評分**：${item.score.toFixed(1)}`);
  }
  if (item.chineseSupport !== null && item.chineseSupport !== undefined) {
    infoLines.push(`**中文**：${item.chineseSupport ? "支援" : "不支援"}`);
  }
  const remaining = formatRemaining(item.endTime);
  if (remaining) infoLines.push(`**截止**：${remaining}`);
  if (item.isDlc && item.parentName) {
    infoLines.push(`**本體**：${item.parentName}`);
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(infoLines.join("\n")),
    );

  const shortDesc = steamData?.short_description || item.description;
  if (shortDesc) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**簡介**\n${truncate(shortDesc, 100)}`,
      ),
    );
  }

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `-# 來源：GamerPower ・ <t:${Math.floor(Date.now() / 1000)}:R>`,
    ),
  );

  return container;
};

module.exports = { buildFreeGameContainer, PLATFORM_META };
