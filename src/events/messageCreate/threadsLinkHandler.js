const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
} = require("discord.js");

// ============================================================
// Threads Embed Handler - 支援 Carousel 多圖 + 影片
// 輕量版：HTTP fetch + Googlebot UA
// ============================================================

// 解碼 HTML entities
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");
}

// 遞迴搜尋 nested object 中的特定 key
function nestedLookup(key, obj, results = []) {
  if (!obj || typeof obj !== "object") return results;

  if (key in obj) {
    results.push(obj[key]);
  }

  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      nestedLookup(key, v, results);
    }
  }

  return results;
}

// 解析單一 thread item
function parseThreadItem(data) {
  const post = data?.post;
  if (!post) return null;

  const result = {
    code: post?.code || null,
    text: post?.caption?.text || "",
    username: post?.user?.username || "unknown",
    userPic: post?.user?.profile_pic_url || null,
    isVerified: post?.user?.is_verified || false,
    likeCount: post?.like_count || 0,
    replyCount: post?.text_post_app_info?.direct_reply_count || 0,
    images: [],
    videos: [],
  };

  // 處理 carousel（多圖/多影片）
  if (post?.carousel_media && Array.isArray(post.carousel_media)) {
    for (const media of post.carousel_media) {
      // 圖片
      if (media?.image_versions2?.candidates) {
        const candidates = media.image_versions2.candidates;
        // 選擇適中解析度的圖片（通常 index 0 或 1）
        const imgUrl = candidates[0]?.url || candidates[1]?.url;
        if (imgUrl) {
          result.images.push(imgUrl.replace(/&amp;/g, "&"));
        }
      }
      // 影片
      if (media?.video_versions && Array.isArray(media.video_versions)) {
        const videoUrl = media.video_versions[0]?.url;
        if (videoUrl) {
          result.videos.push(videoUrl.replace(/&amp;/g, "&"));
        }
      }
    }
  }

  // 單一圖片貼文（非 carousel）
  if (result.images.length === 0 && post?.image_versions2?.candidates) {
    const candidates = post.image_versions2.candidates;
    const imgUrl = candidates[0]?.url || candidates[1]?.url;
    if (imgUrl) {
      result.images.push(imgUrl.replace(/&amp;/g, "&"));
    }
  }

  // 單一影片貼文（非 carousel）
  if (result.videos.length === 0 && post?.video_versions) {
    const videos = post.video_versions;
    if (Array.isArray(videos) && videos.length > 0) {
      // 去重
      const uniqueVideos = [...new Set(videos.map((v) => v?.url).filter(Boolean))];
      result.videos = uniqueVideos.map((url) => url.replace(/&amp;/g, "&"));
    }
  }

  return result;
}

// 從 HTML 中提取 hidden JSON 並解析 thread 資料
// 頁面 JSON 會夾帶多篇貼文（推薦、相關、回覆串），必須用 URL 的 shortcode
// 比對 post.code，否則會抓到「第一個有內容的」別篇貼文。
function extractThreadDataFromHtml(html, targetCode) {
  // 找所有 <script type="application/json" data-sjs> 標籤
  const scriptRegex =
    /<script[^>]*type=["']application\/json["'][^>]*data-sjs[^>]*>([\s\S]*?)<\/script>/gi;

  let match;
  let fallback = null; // 第一個有內容的貼文，僅在沒有 targetCode 時使用
  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1];

    // 快速過濾：必須包含 thread_items
    if (!content.includes('"ScheduledServerJS"')) continue;
    if (!content.includes("thread_items")) continue;

    try {
      const data = JSON.parse(content);
      const threadItems = nestedLookup("thread_items", data);

      if (threadItems && threadItems.length > 0) {
        // thread_items 是 array of arrays，逐篇檢查（貼文可能在串中任一位置）
        for (const items of threadItems) {
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            const parsed = parseThreadItem(item);
            const hasContent =
              parsed &&
              (parsed.text || parsed.images.length > 0 || parsed.videos.length > 0);
            if (!hasContent) continue;

            // 找到 URL 指定的那一篇 → 直接回傳
            if (targetCode && parsed.code === targetCode) {
              return parsed;
            }
            if (!fallback) fallback = parsed;
          }
        }
      }
    } catch (e) {
      // JSON parse 失敗，繼續嘗試下一個 script
      continue;
    }
  }

  // 有指定 code 卻找不到對應貼文 → 回 null，改用 og:meta（針對該 URL 較準確）
  return targetCode ? null : fallback;
}

// Fallback: 從 og meta tags 抓取（原本的方式）
function extractFromOgMeta(html) {
  const title = html.match(/<meta property="og:title" content="([^"]*?)"/)?.[1];
  const description = html.match(
    /<meta property="og:description" content="([^"]*?)"/
  )?.[1];

  // 抓所有圖片
  const imageMatches = [
    ...html.matchAll(/<meta property="og:image" content="([^"]*?)"/g),
  ];
  const allImages = imageMatches.map((m) => m[1].replace(/&amp;/g, "&"));

  // 過濾大頭貼：Instagram CDN 大頭貼路徑格式為 /t51.xxxxx-19/
  const images = allImages.filter((url) => !/\/t51\.\d+-19\//.test(url));

  if (!title && !description && images.length === 0) return null;

  // 偵測 Threads 登入牆 / 通用頁（拿不到貼文時 Meta 會回這個）
  // 這種頁的 og:description 是固定招呼語、og:image 是 Threads logo，
  // 不能拿來當預覽，否則會貼出一張無意義的「Join Threads」卡片。
  const desc = description ? decodeHtmlEntities(description) : "";
  const isGenericPage =
    /Join Threads to share ideas/i.test(desc) ||
    /Log in with your Instagram/i.test(desc) ||
    /^Threads$/i.test(title || "");
  if (isGenericPage) return null;

  // 從 title 解析 username
  let username = "unknown";
  if (title) {
    // 格式通常是 "@username on Threads" 或 "username (@handle)"
    const usernameMatch = title.match(/@([\w.]+)/);
    if (usernameMatch) {
      username = usernameMatch[1];
    }
  }

  return {
    text: desc,
    username,
    userPic: null,
    isVerified: false,
    likeCount: 0,
    replyCount: 0,
    images,
    videos: [],
  };
}

// 不同 UA 拿到的頁面差很多：有些只回登入牆 / 推薦貼文，沒有目標貼文的
// SSR JSON。逐一嘗試，誰先拿到「code 吻合的貼文」就用誰。
const FETCH_USER_AGENTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

async function fetchHtml(url, userAgent) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 秒 timeout
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      console.log(`[Threads] HTTP ${response.status} for ${url}`);
      return null;
    }
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

// 貼文永久連結的 shortcode（分享短連結的 code 不是這個，不能直接拿來比對）
function postCodeFromUrl(url) {
  return url?.match(/\/post\/([\w-]+)/)?.[1] || null;
}

// 分享短連結（/share/xxx）本身沒有 shortcode（那串是分享 id，跟貼文 code 無關），
// 得從頁面找出真正的貼文。轉址可能發生在 server（fetch 直接跟到）也可能在前端 JS
// （fetch 停在短連結），所以每種線索都試一次。
// 回傳 { code, url }：url 可能為 null（只挖到 shortcode，仍足以鎖定 JSON 裡的貼文）
function extractPostRef(html) {
  const urlPatterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"';]+)["']/i,
  ];
  for (const re of urlPatterns) {
    const href = html.match(re)?.[1];
    if (!href) continue;
    const decoded = decodeHtmlEntities(href.trim());
    const code = postCodeFromUrl(decoded);
    if (code) return { code, url: decoded };
  }

  // App Links（barcelona://post?shortcode=xxx）只給得出 shortcode，沒有永久連結
  const appLink = html.match(
    /<meta[^>]+property=["']al:(?:ios|android):url["'][^>]+content=["']([^"']+)["']/i,
  )?.[1];
  if (appLink) {
    const decoded = decodeHtmlEntities(appLink);
    const code =
      postCodeFromUrl(decoded) || decoded.match(/shortcode=([\w-]+)/)?.[1];
    if (code) return { code, url: null };
  }

  return null;
}

// 主要抓取函數
// 回傳 { data, reachable, canonicalUrl }：
//   data         解析到的貼文，抓不到為 null
//   reachable    是否至少有一個 UA 成功取得頁面（HTTP 200）
//                用來區分「網路/被擋」與「這篇沒有可用的公開資料（gate 掉）」，
//                後者不該算進 circuit breaker，否則會連累正常貼文。
//   canonicalUrl 短連結解析後的貼文永久連結，解析不到就是原網址
async function fetchThreadsData(url) {
  // 從 URL 取出貼文 shortcode，用來鎖定頁面 JSON 中正確的那一篇
  let targetCode = postCodeFromUrl(url);
  let canonicalUrl = targetCode ? url : null;

  let ogFallback = null; // 各 UA 拿到的最佳 og:meta（已濾掉登入牆）
  let reachable = false;

  for (const ua of FETCH_USER_AGENTS) {
    let fetched;
    try {
      fetched = await fetchHtml(url, ua);
    } catch (error) {
      if (error.name === "AbortError") {
        console.log(`[Threads] 請求超時：${url}`);
      } else {
        console.log(`[Threads] 抓取失敗：${error.message}`);
      }
      continue;
    }
    if (!fetched) continue;
    reachable = true;

    const { html, finalUrl } = fetched;

    // 分享短連結：先解析出真正的貼文，才有 shortcode 可以比對
    if (!targetCode) {
      if (postCodeFromUrl(finalUrl)) {
        canonicalUrl = finalUrl;
        targetCode = postCodeFromUrl(finalUrl);
      } else {
        const ref = extractPostRef(html);
        if (ref) {
          targetCode = ref.code;
          if (ref.url) canonicalUrl = ref.url;
        }
      }
    }

    // 拿到 code 吻合的貼文 → 直接成功。
    // 短連結還沒解出 code 時不能走 JSON fallback：頁面 JSON 夾帶多篇貼文，
    // 沒有 code 比對會抓到別人的推薦貼文，寧可退回 og:meta。
    if (targetCode) {
      const data = extractThreadDataFromHtml(html, targetCode);
      if (data) return { data, reachable: true, canonicalUrl: canonicalUrl || url };
    }

    // 還沒成功，先留著這個 UA 的 og:meta（登入牆會被濾成 null）
    if (!ogFallback) {
      ogFallback = extractFromOgMeta(html);
    }
  }

  // 所有 UA 都拿不到目標貼文的 JSON → 退回非登入牆的 og:meta（可能為 null）
  return { data: ogFallback, reachable, canonicalUrl: canonicalUrl || url };
}

// 擷取 Threads 連結（支援 threads.net / threads.com，含新版分享短連結）
//   永久連結：/@user/post/<code>
//   短連結　：/share/<code>、/t/<code>、/p/<code>
function extractThreadsUrl(content) {
  const match = content.match(
    /https?:\/\/(?:www\.)?threads\.(?:net|com)\/(?:@[\w.]+\/post\/[\w-]+|(?:share|t|p)\/[\w-]+)/i,
  );
  return match ? match[0] : null;
}

// Circuit breaker：避免被 Meta 擋掉時還繼續打 request
// 5 分鐘內連續 3 次失敗 → 暫停 30 分鐘
const CB_FAIL_WINDOW_MS = 5 * 60 * 1000;
const CB_FAIL_THRESHOLD = 3;
const CB_PAUSE_MS = 30 * 60 * 1000;
const circuit = {
  failures: [], // timestamps
  pausedUntil: 0,
};

function circuitOpen() {
  return Date.now() < circuit.pausedUntil;
}

function recordFailure() {
  const now = Date.now();
  circuit.failures = circuit.failures.filter(
    (t) => now - t <= CB_FAIL_WINDOW_MS,
  );
  circuit.failures.push(now);
  if (circuit.failures.length >= CB_FAIL_THRESHOLD) {
    circuit.pausedUntil = now + CB_PAUSE_MS;
    circuit.failures = [];
    console.log(
      `[Threads] 連續 ${CB_FAIL_THRESHOLD} 次抓取失敗，暫停 ${CB_PAUSE_MS / 60000} 分鐘`,
    );
  }
}

function recordSuccess() {
  circuit.failures = [];
}

// 格式化數字（1000 -> 1K）
function formatNumber(num) {
  if (!num || num < 1000) return String(num || 0);
  if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

// 主要 handler
module.exports = async (client, message) => {
  if (message.author.bot) return;

  const threadsUrl = extractThreadsUrl(message.content);
  if (!threadsUrl) return;

  if (circuitOpen()) return;

  try {
    const { data, reachable, canonicalUrl } = await fetchThreadsData(threadsUrl);
    if (!data) {
      // 只有真的連不上才算進熔斷；頁面拿到但這篇無公開資料（gate 掉）不算，
      // 否則會害正常貼文一起被暫停。此時不 suppressEmbeds，保留 Discord 原生預覽。
      if (!reachable) recordFailure();
      return;
    }
    recordSuccess();

    // 主頭：作者 + 文字
    const headLines = [
      `-# [@${data.username}${data.isVerified ? " ✓" : ""}](${canonicalUrl})`,
    ];
    if (data.text) {
      const desc =
        data.text.length > 400 ? data.text.slice(0, 400) + "..." : data.text;
      headLines.push(desc);
    }

    const container = new ContainerBuilder()
      .setAccentColor(0x000000)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(headLines.join("\n")),
      );

    // 圖片牆（最多 10 張）
    if (data.images.length > 0) {
      const gallery = new MediaGalleryBuilder();
      for (let i = 0; i < Math.min(data.images.length, 10); i++) {
        gallery.addItems(new MediaGalleryItemBuilder().setURL(data.images[i]));
      }
      container.addMediaGalleryComponents(gallery);
    }

    // 互動數據與影片提示
    const stats = [];
    if (data.likeCount > 0) stats.push(`❤️ ${formatNumber(data.likeCount)}`);
    if (data.replyCount > 0) stats.push(`💬 ${formatNumber(data.replyCount)}`);
    if (data.images.length > 10) stats.push(`📷 +${data.images.length - 10} more`);
    if (data.videos.length > 0) stats.push("🎬 此貼文包含影片");
    if (stats.length > 0) {
      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`-# ${stats.join("  •  ")}`),
        );
    }

    // 隱藏原始 embed
    await message.suppressEmbeds(true);

    await message.reply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.log(`[ERROR] Threads link handler 發生錯誤：\n${error}`);
  }
};
