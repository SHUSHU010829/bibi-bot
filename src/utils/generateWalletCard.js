// 錢包卡入口：根據使用者裝備的風格 dispatch 到對應 cardStyles 模組。
// Satori 限制請見各 cardStyles/*.js 檔案。

const LruCache = require("./lruCache");
const { getStyle, resolveStyleId } = require("./cardStyles");
const { renderCard } = require("./cardRenderer");

const walletCardCache = new LruCache(256);

function buildCacheKey(data, styleId) {
  return [
    styleId,
    data.userId || "",
    data.guildId || "",
    data.username || "",
    data.totalCoins ?? "",
    data.lifetimeCoins ?? "",
    data.cardNo || "",
    data.tier || "",
    data.cardNumber || "",
  ].join("|");
}

async function generateWalletCard(data) {
  // 風格 ID 來源：data.styleId 優先；其次相容舊 data.theme.styleId
  const requested = data.styleId || data.theme?.styleId || data.theme?.themeId;
  const styleId = resolveStyleId(requested);

  const cacheKey = buildCacheKey(data, styleId);
  const cached = walletCardCache.get(cacheKey);
  if (cached) return cached;

  const { mod } = getStyle(styleId);
  const markup = mod.wallet(data);

  const buf = await renderCard({ markup, width: 1080, height: 600 });
  walletCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateWalletCard;
