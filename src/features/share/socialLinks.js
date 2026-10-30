const { share } = require("../../config");

// X / Twitter 與 IG 不抓頁面，只把網址整理成乾淨的永久連結（丟掉 ?s= / ?t= / ?igsh= 這類追蹤碼），
// 預覽交給 previewHosts 設定的 embed 代理（fxtwitter / kkinstagram）產生。
const TWITTER_RE =
  /https?:\/\/(?:(?:www|mobile)\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/(?:i\/(?:web\/)?status|(\w{1,15})\/status(?:es)?)\/(\d+)/i;

const INSTAGRAM_RE =
  /https?:\/\/(?:(?:www|m)\.)?(?:instagram|ddinstagram|kkinstagram)\.com\/(?:[\w.]+\/)?(p|reels?|tv)\/([\w-]+)/i;

function parseTwitter(input) {
  const match = input.match(TWITTER_RE);
  if (!match) return null;
  const [, username, id] = match;
  const path = `${username || "i"}/status/${id}`;
  return {
    platform: "twitter",
    username: username || null,
    url: `https://x.com/${path}`,
    previewUrl: `https://${share.previewHosts.twitter}/${path}`,
  };
}

function parseInstagram(input) {
  const match = input.match(INSTAGRAM_RE);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const kind = raw === "reels" ? "reel" : raw;
  const path = `${kind}/${match[2]}/`;
  return {
    platform: "instagram",
    kind,
    url: `https://www.instagram.com/${path}`,
    previewUrl: `https://${share.previewHosts.instagram}/${path}`,
  };
}

// 回傳 { platform, url, previewUrl, ... }，認不得回 null
function parseSocialLink(input) {
  return parseTwitter(input || "") || parseInstagram(input || "");
}

module.exports = { parseSocialLink };
