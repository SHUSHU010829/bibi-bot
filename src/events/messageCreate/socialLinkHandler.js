const { MessageFlags } = require("discord.js");

const { maskHiddenSegments } = require("../../utils/hiddenLinks");

// ============================================================
// 社群連結修正 — Instagram / X(Twitter)
// Discord 對 x.com / twitter.com / instagram.com 的原生預覽常常失效
// （無圖、無影片、抓不到內文）。換成社群鏡像網域後可拿到完整預覽：
//   twitter.com  → fxtwitter.com
//   x.com        → fixupx.com
//   instagram.com→ oginstagram.com
// 只針對「單篇貼文」連結（status / p / reel / tv），個人頁與首頁不動。
// 被藏起來的連結（<網址> / 防雷 / 程式碼區塊）不修正，維持沒有預覽。
// ============================================================

const REWRITES = [
  {
    // twitter.com/<user>/status/<id>
    pattern:
      /https?:\/\/(?:www\.|mobile\.)?twitter\.com\/(\w{1,15}\/status\/\d+)(\S*)/gi,
    build: (m) => `https://fxtwitter.com/${m[1]}${m[2] || ""}`,
  },
  {
    // x.com/<user>/status/<id>
    pattern: /https?:\/\/(?:www\.)?x\.com\/(\w{1,15}\/status\/\d+)(\S*)/gi,
    build: (m) => `https://fixupx.com/${m[1]}${m[2] || ""}`,
  },
  {
    // instagram.com/(p|reel|reels|tv)/<code>
    pattern:
      /https?:\/\/(?:www\.)?instagram\.com\/((?:p|reel|reels|tv)\/[\w-]+)(\S*)/gi,
    build: (m) => `https://oginstagram.com/${m[1]}${m[2] || ""}`,
  },
];

// 收集訊息中所有可修正的連結，依出現順序回傳修正後的網址
function collectFixedLinks(content) {
  const found = [];
  for (const { pattern, build } of REWRITES) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      found.push({ index: match.index, url: build(match) });
    }
  }
  found.sort((a, b) => a.index - b.index);

  const seen = new Set();
  const links = [];
  for (const { url } of found) {
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

module.exports = async (client, message) => {
  if (message.author.bot) return;

  const links = collectFixedLinks(maskHiddenSegments(message.content));
  if (links.length === 0) return;

  try {
    await message.suppressEmbeds(true);

    await message.reply({
      content: links.join("\n"),
      flags: MessageFlags.SuppressNotifications,
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.log(`[ERROR] Social link handler 發生錯誤：\n${error}`);
  }
};
