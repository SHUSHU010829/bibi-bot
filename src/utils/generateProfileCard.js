// 等級卡入口：跟錢包卡共用同一套風格系統，依 styleId 分派到 cardStyles 模組。
// avatarUrl 會自動 fetch 後轉 base64 data URI 注入給風格元件使用。

const LruCache = require("./lruCache");
const { getStyle, resolveStyleId } = require("./cardStyles");
const { renderCard, fetchAvatarDataUri } = require("./cardRenderer");

const profileCardCache = new LruCache(256);

function buildCacheKey(data, styleId) {
  const badges = Array.isArray(data.badges)
    ? data.badges
        .map((b) => (b && typeof b === "object" ? b.id || b.key || JSON.stringify(b) : b))
        .join(",")
    : "";
  return [
    styleId,
    data.userId || "",
    data.guildId || "",
    data.username || "",
    data.avatarUrl || "",
    data.level ?? "",
    data.totalXp ?? "",
    data.streak ?? "",
    data.streakFreezes ?? "",
    data.totalMessages ?? "",
    data.totalVoiceMinutes ?? "",
    data.rank ?? "",
    data.totalUsers ?? "",
    badges,
    data.title || "",
  ].join("|");
}

async function generateProfileCard(data) {
  const requested = data.styleId || data.theme?.styleId || data.theme?.themeId;
  const styleId = resolveStyleId(requested);

  const cacheKey = buildCacheKey(data, styleId);
  const cached = profileCardCache.get(cacheKey);
  if (cached) return cached;

  const avatarDataUri = await fetchAvatarDataUri(data.avatarUrl);
  const { mod } = getStyle(styleId);
  const markup = mod.level({ ...data, avatarDataUri });

  const buf = await renderCard({ markup, width: 1080, height: 600 });
  profileCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateProfileCard;
