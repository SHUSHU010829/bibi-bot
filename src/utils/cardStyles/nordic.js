// 北歐極簡風格：米白底 + 莫蘭迪藍綠 + 珊瑚橘點綴 + 大量留白 + 細線手繪
// Satori 限制：避免複雜裝飾。拱門用 border-radius 上半圓模擬。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  bg: "#F5F0E6",
  bgSoft: "#EAE3D2",
  ink: "#2D3438",
  teal: "#7A9B8E",
  coral: "#E89B7B",
  line: "#C9C0AE",
  dim: "#8A8275",
};

function frame(inner) {
  return `
    <div style="display:flex;width:1080px;height:600px;background:${COLORS.bg};padding:36px;box-sizing:border-box;font-family:'NotoSansTC';flex-direction:column;">
      ${inner}
    </div>
  `;
}

function smallDivider() {
  return `<div style="display:flex;width:36px;height:2px;background:${COLORS.coral};"></div>`;
}

function wallet(data) {
  const name = safeUsername(data.username, 14);
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);

  const inner = `
    <!-- 拱門裝飾：兩個矩形 + 上半圓 -->
    <div style="display:flex;width:100%;align-items:flex-end;justify-content:space-between;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:8px;color:${COLORS.dim};">— 0${cardNo.slice(-1)} —</div>
        <div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${COLORS.ink};letter-spacing:6px;">錢　包</div>
        <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${COLORS.teal};">QUIET WALLET / NORDIC EDITION</div>
      </div>
      <!-- 拱門 -->
      <div style="display:flex;width:120px;height:100px;align-items:flex-end;justify-content:center;">
        <div style="display:flex;width:100px;height:80px;border:2px solid ${COLORS.teal};border-bottom:0;border-top-left-radius:50px;border-top-right-radius:50px;box-sizing:border-box;align-items:flex-start;justify-content:center;">
          <div style="display:flex;width:2px;height:60px;background:${COLORS.coral};margin-top:14px;"></div>
        </div>
      </div>
    </div>

    <!-- 細線分隔 -->
    <div style="display:flex;width:100%;height:1px;background:${COLORS.line};margin-top:24px;"></div>

    <!-- 主數字 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:30px;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${smallDivider()}
        <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:6px;color:${COLORS.dim};">BALANCE</div>
      </div>
      <div style="display:flex;align-items:flex-end;margin-top:12px;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:130px;color:${COLORS.ink};line-height:1;letter-spacing:-2px;">${balance}</div>
        <div style="display:flex;margin-left:14px;margin-bottom:18px;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${COLORS.coral};letter-spacing:6px;">金幣</div>
      </div>
    </div>

    <!-- 底部：右下角名字 + 累積 -->
    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">HOLDER</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${COLORS.ink};letter-spacing:2px;">${htmlEscape(name)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">LIFETIME</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:20px;color:${COLORS.teal};letter-spacing:2px;">${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarSize = 120;
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;border-radius:9999px;" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.teal};color:${COLORS.bg};font-family:'NotoSansTC';font-weight:900;font-size:54px;justify-content:center;align-items:center;border-radius:9999px;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "MESSAGES", v: fmtNumber(data.totalMessages || 0) },
    { label: "VOICE", v: `${data.totalVoiceMinutes || 0}m` },
    { label: "STREAK", v: `${data.streak || 0}` },
    { label: "TOTAL XP", v: fmtNumber(data.totalXp || 0) },
  ];

  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;padding:6px 4px;box-sizing:border-box;">
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${COLORS.dim};">${s.label}</div>
          <div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${COLORS.ink};">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.bgSoft};border:1px solid ${COLORS.line};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.ink};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:transparent;border:1px dashed ${COLORS.line};box-sizing:border-box;opacity:0.6;"></div>
      `,
    )
    .join("");

  const inner = `
    <div style="display:flex;width:100%;align-items:flex-start;justify-content:space-between;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;gap:14px;">
          ${smallDivider()}
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:8px;color:${COLORS.dim};">PROFILE / 等 級</div>
        </div>
        <div style="display:flex;margin-top:10px;font-family:'NotoSansTC';font-weight:900;font-size:46px;color:${COLORS.ink};letter-spacing:4px;line-height:1.1;">${htmlEscape(name)}</div>
        <div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${COLORS.teal};letter-spacing:6px;padding-left:6px;">${htmlEscape(data.title || "—")}</div>
        <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;letter-spacing:3px;color:${COLORS.dim};">#${data.rank || 0} / ${data.totalUsers || 0}</div>
      </div>
      <!-- 圓形頭像 + 拱形外圈 -->
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;width:136px;height:136px;border:1px solid ${COLORS.line};border-radius:9999px;align-items:center;justify-content:center;box-sizing:border-box;">
          ${avatarHtml}
        </div>
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${COLORS.dim};">LEVEL</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:60px;color:${COLORS.coral};line-height:1;">${data.level || 0}</div>
      </div>
    </div>

    <div style="display:flex;width:100%;height:1px;background:${COLORS.line};margin-top:22px;"></div>

    <!-- 進度 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:20px;">
      <div style="display:flex;width:100%;justify-content:space-between;font-family:'SpaceMono';font-size:14px;color:${COLORS.dim};letter-spacing:3px;margin-bottom:6px;">
        <div style="display:flex;">EXP — ${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)}</div>
        <div style="display:flex;">${pct}%</div>
      </div>
      <div style="display:flex;width:100%;height:8px;background:${COLORS.bgSoft};">
        <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.teal};"></div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:20px;gap:8px;">
      ${statsHtml}
    </div>

    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:14px;">
        ${smallDivider()}
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${COLORS.dim};">BADGES ${badgesArr.length}/5</div>
      </div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
