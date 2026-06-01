const { getTier } = require("./levelTier");
const LruCache = require("./lruCache");
const { renderCard, fetchAvatarDataUri } = require("./cardRenderer");

const levelUpCardCache = new LruCache(256);

function buildMarkup({ username, avatarDataUri, beforeLevel, afterLevel, totalXp }) {
  const tier = getTier(afterLevel);
  const ink = "#2A2420";
  const card = "#F4ECD8";
  const muted = "#A89270";
  const accent = tier.color;

  const avatarHtml = avatarDataUri
    ? `<img src="${avatarDataUri}" style="display:flex;width:130px;height:130px;object-fit:cover;" />`
    : `<div style="display:flex;width:130px;height:130px;background:${ink};color:${card};font-family:'NotoSansTC';font-weight:900;font-size:64px;justify-content:center;align-items:center;">${(username || "?").charAt(0).toUpperCase()}</div>`;

  return `
    <div style="display:flex;width:800px;height:400px;background:${card};padding:18px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;width:100%;height:100%;background:${card};border:3px solid ${ink};padding:30px 36px;box-sizing:border-box;align-items:center;">

        <div style="display:flex;width:140px;height:140px;background:${accent};padding:5px;box-sizing:border-box;align-items:center;justify-content:center;">
          ${avatarHtml}
        </div>

        <div style="display:flex;flex-direction:column;flex:1;margin-left:30px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:16px;letter-spacing:8px;color:${muted};">— LEVEL UP —</div>
          <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${ink};line-height:1.1;">${username}</div>

          <div style="display:flex;align-items:center;margin-top:14px;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:50px;color:${muted};line-height:1;">Lv.${beforeLevel}</div>
            <div style="display:flex;margin:0 18px;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${ink};">→</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:80px;color:${accent};line-height:1;">Lv.${afterLevel}</div>
          </div>

          <div style="display:flex;margin-top:16px;align-items:center;justify-content:space-between;">
            <div style="display:flex;align-items:center;padding:6px 14px;background:${accent};">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:16px;line-height:1;margin-right:6px;">${tier.emoji}</div>
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:16px;color:${card};letter-spacing:5px;">${tier.label}</div>
            </div>
            <div style="display:flex;font-family:'SpaceMono';font-size:16px;color:${ink};">${totalXp.toLocaleString()} XP</div>
          </div>
        </div>

      </div>
    </div>
  `;
}

function buildCacheKey(data) {
  return [
    data.userId || data.username || "",
    data.fromLevel ?? "",
    data.toLevel ?? "",
    data.cardAccent || "",
  ].join("|");
}

async function generateLevelUpCard(data) {
  const cacheKey = buildCacheKey(data);
  const cached = levelUpCardCache.get(cacheKey);
  if (cached) return cached;

  const avatarDataUri = await fetchAvatarDataUri(data.avatarUrl);
  const markup = buildMarkup({ ...data, avatarDataUri });

  const buf = await renderCard({ markup, width: 800, height: 400 });
  levelUpCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateLevelUpCard;
