const Parser = require("rss-parser");
const cheerio = require("cheerio");

const { parseImages } = require("../utils/parseImages");

// 部分 RSS gateway (例如 discord-news.zeabur.app) 會擋非瀏覽器 UA → 403
// 該 gateway 是即時抓 picnob 再轉 RSS,冷啟動 / 上游慢時很容易超過 15s
const FETCH_TIMEOUT_MS = Number(process.env.RSS_FETCH_TIMEOUT_MS) || 45000;

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  },
});

// gateway (RSSHub on Zeabur) 對 picnob 503 會回 `cache-control: max-age=300`,
// 失敗結果被 cache 5 分鐘,短間隔重試只會打到同一個 cached 503。
// 預設排程把最後一次 retry 推到 cache 過期之後,讓重試實際有意義。
const parseRetryDelays = (raw) => {
  if (!raw) return null;
  const arr = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return arr.length ? arr : null;
};

const RETRY_DELAYS_MS = parseRetryDelays(process.env.RSS_FETCH_RETRY_DELAYS_MS) || [
  30_000,
  310_000,
];
const MAX_FETCH_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 503/502/504/429 與網路錯誤都當成暫時性錯誤,值得重試
const isRetryableError = (err) => {
  const msg = err && err.message ? err.message : "";
  const statusMatch = msg.match(/Status code (\d+)/i);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 408 || status === 429 || (status >= 500 && status < 600);
  }
  // rss-parser 的 timeout 直接 throw `new Error('Request timed out after Xms')`,
  // 沒有 err.code,需要用訊息判斷
  if (/timed out|timeout/i.test(msg)) return true;
  const code = err && err.code;
  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNABORTED",
    "ENOTFOUND",
    "EAI_AGAIN",
  ].includes(code);
};

const parseURLWithRetry = async (url) => {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await parser.parseURL(url);
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_FETCH_ATTEMPTS || !isRetryableError(err)) throw err;
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw lastErr;
};

/**
 * @typedef {Object} FeedItem
 * @property {string} guid
 * @property {string} title
 * @property {string|null} link
 * @property {string} pubDate
 * @property {string} textContent
 * @property {string[]} images
 * @property {string} author
 */

const stripHtmlToText = (html) => {
  if (!html) return "";
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, " ").trim();
};

/**
 * Fetch + parse RSS,回傳標準化的 FeedItem 陣列。
 * @param {string} url
 * @returns {Promise<FeedItem[]>}
 */
const fetchFeedItems = async (url) => {
  const feed = await parseURLWithRetry(url);
  const items = Array.isArray(feed.items) ? feed.items : [];

  return items.map((raw) => {
    const description =
      raw["content:encoded"] ||
      raw.content ||
      raw.contentSnippet ||
      raw.description ||
      "";

    const images = parseImages(description);
    const textContent = stripHtmlToText(description);

    const linkRaw = typeof raw.link === "string" ? raw.link.trim() : "";
    const link = linkRaw ? linkRaw : null;

    const guid = raw.guid || raw.id || raw.link || raw.title || "";

    return {
      guid: String(guid),
      title: raw.title || "",
      link,
      pubDate: raw.isoDate || raw.pubDate || "",
      textContent,
      images,
      author: raw.creator || raw.author || raw["dc:creator"] || "",
    };
  });
};

module.exports = { fetchFeedItems, isRetryableError };
