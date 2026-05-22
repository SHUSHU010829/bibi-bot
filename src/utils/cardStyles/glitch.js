// 故障藝術風格：黑底 + RGB 三層分離疊字 + 橫向錯位色帶 + 等寬字體
// Satori 限制：mix-blend-mode 不支援 → 用 position:absolute + opacity 直接疊。
// 三層疊字必須父層 position:relative + 明確寬高。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  bg: "#0F0F0F",
  pink: "#FF0066",
  cyan: "#00FFCC",
  white: "#F5F5F5",
  dim: "#7A7A7A",
  band: "#1A1A1A",
};

// 三層疊字：粉紅 left:-2 / 青藍 left:+2 / 白 0
function glitchText({ text, size = 64, weight = 900, family = "NotoSansTC", letter = 0, height = "auto", width = "auto" }) {
  const baseStyle = `font-family:'${family}';font-weight:${weight};font-size:${size}px;line-height:1;letter-spacing:${letter}px;`;
  const wrapW = width === "auto" ? "" : `width:${width};`;
  const wrapH = height === "auto" ? `height:${size + 8}px;` : `height:${height};`;
  return `
    <div style="display:flex;position:relative;${wrapW}${wrapH}align-items:flex-start;">
      <div style="display:flex;position:absolute;left:-2px;top:0;${baseStyle}color:${COLORS.pink};opacity:0.85;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:2px;top:0;${baseStyle}color:${COLORS.cyan};opacity:0.85;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:0;top:0;${baseStyle}color:${COLORS.white};">${htmlEscape(text)}</div>
    </div>
  `;
}

function glitchBars(bars) {
  // bars: [{ y, h, color, opacity, w }]
  return bars
    .map(
      (b) => `
        <div style="display:flex;position:absolute;left:0;top:${b.y}px;width:${b.w || 1080}px;height:${b.h}px;background:${b.color};opacity:${b.opacity};"></div>
      `,
    )
    .join("");
}

function frame(inner) {
  return `
    <div style="display:flex;position:relative;width:1080px;height:600px;background:${COLORS.bg};font-family:'SpaceMono';">
      ${glitchBars([
        { y: 80, h: 4, color: COLORS.pink, opacity: 0.6 },
        { y: 220, h: 2, color: COLORS.cyan, opacity: 0.7 },
        { y: 360, h: 8, color: COLORS.band, opacity: 1 },
        { y: 470, h: 3, color: COLORS.pink, opacity: 0.4 },
        { y: 540, h: 1, color: COLORS.cyan, opacity: 0.6 },
      ])}
      <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:600px;padding:36px 44px;box-sizing:border-box;flex-direction:column;">
        ${inner}
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 14).toUpperCase();
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);

  const inner = `
    <!-- 頂列：標題 + 系統訊息 -->
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        ${glitchText({ text: "W4LL3T_BAL.SYS", size: 30, family: "SpaceMono", weight: 700, letter: 4, height: "38px", width: "560px" })}
        <div style="display:flex;margin-top:14px;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.dim};">› LOADING WALLET... [OK]</div>
        <div style="display:flex;margin-top:2px;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.pink};">› SIGNAL_LOST :: PARTIAL_RECOVERY</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">CARD//${cardNo}</div>
        <div style="display:flex;margin-top:6px;padding:4px 10px;background:${COLORS.pink};color:${COLORS.bg};font-family:'SpaceMono';font-size:11px;letter-spacing:3px;">${data.tier ? String(data.tier).toUpperCase() : "STANDARD"}</div>
      </div>
    </div>

    <!-- 中央大數字（三層疊） -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:30px;align-items:flex-start;">
      <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:6px;color:${COLORS.cyan};">— BALANCE.RAW —</div>
      <div style="display:flex;margin-top:10px;width:100%;">
        ${glitchText({ text: balance, size: 150, family: "SpaceMono", weight: 700, letter: -2, height: "160px", width: "100%" })}
      </div>
    </div>

    <!-- 底列 -->
    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">USR_HANDLE</div>
        <div style="display:flex;margin-top:4px;">
          ${glitchText({ text: `@${name}`, size: 26, family: "SpaceMono", weight: 700, letter: 3, height: "32px", width: "560px" })}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">LIFETIME.LOG</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:24px;color:${COLORS.cyan};letter-spacing:2px;">${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12).toUpperCase();
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);
  const rank = `#${data.rank || 0}/${data.totalUsers || 0}`;

  const avatarSize = 110;
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.pink};color:${COLORS.bg};font-family:'SpaceMono';font-weight:700;font-size:54px;justify-content:center;align-items:center;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "MSG.LOG", v: fmtNumber(data.totalMessages || 0) },
    { label: "VOX.MIN", v: `${data.totalVoiceMinutes || 0}` },
    { label: "STRK.D", v: `${data.streak || 0}` },
    { label: "XP.TOT", v: fmtNumber(data.totalXp || 0) },
  ];

  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;border:1px solid ${COLORS.cyan};padding:8px 12px;box-sizing:border-box;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.pink};">${s.label}</div>
          <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:22px;color:${COLORS.white};letter-spacing:2px;">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.band};border:1px solid ${COLORS.cyan};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.white};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:transparent;border:1px dashed ${COLORS.pink};box-sizing:border-box;opacity:0.5;"></div>
      `,
    )
    .join("");

  const inner = `
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        ${glitchText({ text: "PR0F1L3.dat", size: 32, family: "SpaceMono", weight: 700, letter: 4, height: "40px", width: "560px" })}
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${COLORS.dim};">› HANDLE: @${htmlEscape(name)} :: RANK ${rank}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">LVL</div>
        ${glitchText({ text: String(data.level || 0), size: 84, family: "SpaceMono", weight: 700, letter: -2, height: "92px", width: "180px" })}
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:24px;align-items:center;">
      <div style="display:flex;width:120px;height:120px;border:2px solid ${COLORS.cyan};padding:5px;box-sizing:border-box;align-items:center;justify-content:center;">
        ${avatarHtml}
      </div>
      <div style="display:flex;flex-direction:column;margin-left:20px;flex:1;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:3px;color:${COLORS.dim};">EXP_PROGRESS</div>
        <div style="display:flex;width:100%;height:18px;margin-top:6px;border:1px solid ${COLORS.pink};box-sizing:border-box;">
          <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.cyan};"></div>
        </div>
        <div style="display:flex;justify-content:space-between;width:100%;margin-top:6px;font-family:'SpaceMono';font-size:11px;color:${COLORS.dim};">
          <div style="display:flex;">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)} XP</div>
          <div style="display:flex;">${pct}%</div>
        </div>
        <div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${COLORS.pink};letter-spacing:4px;padding-left:4px;">${htmlEscape(data.title || "—")}</div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:18px;gap:10px;">
      ${statsHtml}
    </div>

    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${COLORS.cyan};">BADGE.SYS [${badgesArr.length}/5]</div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
