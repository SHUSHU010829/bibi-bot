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
// 回傳：
//   { ok: true, url, original, source }  source: "clean"（本來就是永久連結）/ "resolved"（短連結解析出來的）
//   { ok: false, reason }                reason: "invalid" | "unresolved" | "unreachable"
async function resolveCleanThreadsUrl(input) {
  const url = extractThreadsUrl(input || "");
  if (!url) return { ok: false, reason: "invalid" };

  // 已經是永久連結 → 只要去掉追蹤碼，不用連外
  if (postCodeFromUrl(url)) {
    return {
      ok: true,
      url: stripTracking(url),
      original: input.trim(),
      source: "clean",
    };
  }

  const { data, reachable, canonicalUrl, postCode } = await fetchThreadsData(url);

  if (postCodeFromUrl(canonicalUrl)) {
    recordSuccess();
    return {
      ok: true,
      url: stripTracking(canonicalUrl),
      original: input.trim(),
      source: "resolved",
    };
  }

  // 只挖到 shortcode 沒挖到永久連結時，用貼文作者自己拼一組
  const username =
    data?.username && data.username !== "unknown" ? data.username : null;
  const code = postCode || data?.code;
  if (username && code) {
    recordSuccess();
    return {
      ok: true,
      url: permalinkFrom(username, code),
      original: input.trim(),
      source: "resolved",
    };
  }

  if (!reachable) recordFailure();
  return { ok: false, reason: reachable ? "unresolved" : "unreachable" };
}

module.exports = { resolveCleanThreadsUrl, stripTracking };
