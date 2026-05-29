// 錢包卡入口：根據使用者裝備的風格 dispatch 到對應 cardStyles 模組。
// Satori 限制請見各 cardStyles/*.js 檔案。

const fs = require("fs/promises");
const path = require("path");
const satori = require("satori").default || require("satori");
const { html } = require("satori-html");
const { Resvg } = require("@resvg/resvg-js");

const { loadAdditionalAsset } = require("./satoriEmoji");
const LruCache = require("./lruCache");
const { getStyle, resolveStyleId } = require("./cardStyles");

const walletCardCache = new LruCache(256);

const FONT_DIR = path.join(__dirname, "../../fonts");
let fontsCache = null;

async function loadFonts() {
  if (fontsCache) return fontsCache;
  const [tcBlack, tcMedium, jpBlack, jpMedium, mono] = await Promise.all([
    fs.readFile(path.join(FONT_DIR, "NotoSansTC-Black.woff")),
    fs.readFile(path.join(FONT_DIR, "NotoSansTC-Medium.woff")),
    fs.readFile(path.join(FONT_DIR, "NotoSansJP-Black.otf")),
    fs.readFile(path.join(FONT_DIR, "NotoSansJP-Medium.otf")),
    fs.readFile(path.join(FONT_DIR, "SpaceMono-Regular.woff")),
  ]);
  fontsCache = [
    { name: "SpaceMono", data: mono, weight: 400, style: "normal" },
    { name: "SpaceMono", data: mono, weight: 700, style: "normal" },
    { name: "NotoSansTC", data: tcMedium, weight: 500, style: "normal" },
    { name: "NotoSansTC", data: tcBlack, weight: 900, style: "normal" },
    { name: "NotoSansJP", data: jpMedium, weight: 500, style: "normal" },
    { name: "NotoSansJP", data: jpBlack, weight: 900, style: "normal" },
  ];
  return fontsCache;
}

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
  const element = html(markup);

  const fonts = await loadFonts();
  const svg = await satori(element, {
    width: 1080,
    height: 600,
    fonts,
    loadAdditionalAsset,
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
  })
    .render()
    .asPng();

  const buf = Buffer.from(png);
  walletCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateWalletCard;
