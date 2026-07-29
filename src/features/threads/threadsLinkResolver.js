const {
  fetchThreadsData,
  extractThreadsUrl,
  postCodeFromUrl,
  recordFailure,
  recordSuccess,
} = require("./threadsScraper");

// 貼文永久連結不需要任何 query string，追蹤碼（xmt / igshid / utm_*）全部丟掉。
// extractThreadsUrl 只會吃到 /post/<code> 為止，順便把 /media 之類的尾巴也切掉。
function stripTracking(url) {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url;
  }
}

function permalinkFrom(username, code) {
  return `https://www.threads.com/@${username}/post/${code}`;
}

// 把任何 Threads 連結整理成乾淨的貼文永久連結
// withPreview：連永久連結也去抓一次頁面，順便帶回貼文內容（拿不到不影響連結）
// 回傳：
//   { ok: true, url, data }   data: 貼文內容，沒抓到為 null
//   { ok: false, reason }     reason: "invalid" | "unresolved" | "unreachable"
async function resolveCleanThreadsUrl(input, { withPreview = false } = {}) {
  const url = extractThreadsUrl(input || "");
  if (!url) return { ok: false, reason: "invalid" };

  // 已經是永久連結 → 去掉追蹤碼就結束，不需要連外（除非要順便抓內容）
  if (postCodeFromUrl(url)) {
    const cleanUrl = stripTracking(url);
    if (!withPreview) return { ok: true, url: cleanUrl, data: null };
    const { data, reachable } = await fetchThreadsData(cleanUrl);
    if (data) recordSuccess();
    else if (!reachable) recordFailure();
    return { ok: true, url: cleanUrl, data };
  }

  const { data, reachable, canonicalUrl, postCode } = await fetchThreadsData(url);

  if (postCodeFromUrl(canonicalUrl)) {
    recordSuccess();
    return { ok: true, url: stripTracking(canonicalUrl), data };
  }

  // 只挖到 shortcode 沒挖到永久連結時，用貼文作者自己拼一組
  const username =
    data?.username && data.username !== "unknown" ? data.username : null;
  const code = postCode || data?.code;
  if (username && code) {
    recordSuccess();
    return { ok: true, url: permalinkFrom(username, code), data };
  }

  if (!reachable) recordFailure();
  return { ok: false, reason: reachable ? "unresolved" : "unreachable" };
}

module.exports = { resolveCleanThreadsUrl, stripTracking };
