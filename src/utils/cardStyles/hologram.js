// 全息投影風格：深藍 + 虹彩多層疊字 + 四角 L 形掃描框 + 半透明色帶分區
// Satori 限制：四角 L 形透過設定特定 border 邊呈現。
//   六角形頭像近似：borderRadius: 12 + transform: rotate(45deg) 的菱形變體。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  bg: "#0A1929",
  bgMid: "#0F2238",
  cyan: "#00E5FF",
  pink: "#FF4DCB",
  green: "#7CFF80",
  white: "#EAF6FF",
  dim: "#3A6080",
};

function holoFrame(corner) {
  // L 形角落：用 border 兩邊
  const sz = 28;
  const positions = {
    tl: `left:18px;top:18px;border-left:3px solid ${COLORS.cyan};border-top:3px solid ${COLORS.cyan};`,
    tr: `right:18px;top:18px;border-right:3px solid ${COLORS.cyan};border-top:3px solid ${COLORS.cyan};`,
    bl: `left:18px;bottom:18px;border-left:3px solid ${COLORS.cyan};border-bottom:3px solid ${COLORS.cyan};`,
    br: `right:18px;bottom:18px;border-right:3px solid ${COLORS.cyan};border-bottom:3px solid ${COLORS.cyan};`,
  };
  return `<div style="display:flex;position:absolute;${positions[corner]}width:${sz}px;height:${sz}px;"></div>`;
}

// 四層疊字。父層需給明確寬度以免在 flex 中寬度塌成 0 與相鄰元素疊在一起。
function holoText({ text, size = 60, weight = 900, family = "NotoSansTC", letter = 0, width = "auto" }) {
  const baseStyle = `font-family:'${family}';font-weight:${weight};font-size:${size}px;line-height:1;letter-spacing:${letter}px;white-space:nowrap;`;
  const wrapW = width === "auto" ? "" : `width:${width};`;
  return `
    <div style="display:flex;position:relative;${wrapW}height:${size + 6}px;">
      <div style="display:flex;position:absolute;left:-2px;top:0;${baseStyle}color:${COLORS.pink};opacity:0.7;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:2px;top:0;${baseStyle}color:${COLORS.cyan};opacity:0.7;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:0;top:2px;${baseStyle}color:${COLORS.green};opacity:0.6;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:0;top:0;${baseStyle}color:${COLORS.white};">${htmlEscape(text)}</div>
    </div>
  `;
}

function bands() {
  // 三段半透明色帶
  return `
    <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:200px;background:${COLORS.cyan};opacity:0.06;"></div>
    <div style="display:flex;position:absolute;left:0;top:200px;width:1080px;height:200px;background:${COLORS.pink};opacity:0.05;"></div>
    <div style="display:flex;position:absolute;left:0;top:400px;width:1080px;height:200px;background:${COLORS.green};opacity:0.05;"></div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;position:relative;width:1080px;height:600px;background:${COLORS.bg};font-family:'NotoSansTC';">
      ${bands()}
      ${holoFrame("tl")}${holoFrame("tr")}${holoFrame("bl")}${holoFrame("br")}
      <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:600px;padding:46px;box-sizing:border-box;flex-direction:column;">
        ${inner}
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 14);
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);

  const inner = `
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        ${holoText({ text: "HOLO WALLET", size: 32, family: "SpaceMono", weight: 700, letter: 6 })}
        <div style="display:flex;margin-top:8px;font-family:'NotoSansTC';font-weight:900;font-size:42px;color:${COLORS.cyan};letter-spacing:14px;line-height:1;padding-left:14px;">全 息 錢 包</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:5px;color:${COLORS.dim};">SCAN //</div>
        <div style="display:flex;margin-top:2px;font-family:'SpaceMono';font-weight:700;font-size:18px;color:${COLORS.green};letter-spacing:3px;">${cardNo}-OK</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;width:100%;margin-top:36px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:8px;color:${COLORS.cyan};">— BALANCE / 餘 額 —</div>
      <div style="display:flex;margin-top:14px;align-items:flex-end;">
        ${holoText({ text: balance, size: 140, family: "SpaceMono", weight: 700, letter: -2, width: "560px" })}
        <div style="display:flex;margin-left:18px;margin-bottom:18px;font-family:'NotoSansTC';font-weight:500;font-size:20px;color:${COLORS.pink};letter-spacing:6px;padding-left:6px;">CREDITS</div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">USER</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${COLORS.green};letter-spacing:3px;">${htmlEscape(name)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.dim};">LIFETIME</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${COLORS.cyan};letter-spacing:2px;">${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarSize = 96;
  // 六角形近似：borderRadius 12 + rotate 45deg 雙層
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;transform:rotate(-45deg);border-radius:12px;" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.cyan};color:${COLORS.bg};font-family:'NotoSansTC';font-weight:900;font-size:42px;justify-content:center;align-items:center;transform:rotate(-45deg);border-radius:12px;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "MSG", v: fmtNumber(data.totalMessages || 0), c: COLORS.cyan },
    { label: "VOX", v: `${data.totalVoiceMinutes || 0}`, c: COLORS.pink },
    { label: "STRK", v: `${data.streak || 0}`, c: COLORS.green },
    { label: "XP", v: fmtNumber(data.totalXp || 0), c: COLORS.cyan },
  ];
  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;border:1px solid ${s.c};padding:8px 10px;box-sizing:border-box;background:${COLORS.bgMid};">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${s.c};">${s.label}</div>
          <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${COLORS.white};letter-spacing:2px;">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.bgMid};border:1px solid ${COLORS.cyan};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.white};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:transparent;border:1px dashed ${COLORS.dim};box-sizing:border-box;opacity:0.5;"></div>
      `,
    )
    .join("");

  const inner = `
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        ${holoText({ text: "HOLO PROFILE", size: 28, family: "SpaceMono", weight: 700, letter: 5 })}
        <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${COLORS.cyan};letter-spacing:12px;padding-left:12px;">全 息 等 級</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${COLORS.dim};">LEVEL</div>
        ${holoText({ text: String(data.level || 0), size: 96, family: "SpaceMono", weight: 700, letter: -2, width: "220px" })}
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:22px;align-items:center;">
      <!-- 六角形容器 -->
      <div style="display:flex;width:140px;height:140px;align-items:center;justify-content:center;">
        <div style="display:flex;width:100px;height:100px;border:2px solid ${COLORS.pink};box-sizing:border-box;border-radius:12px;align-items:center;justify-content:center;transform:rotate(45deg);">
          ${avatarHtml}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;margin-left:22px;flex:1;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${COLORS.white};letter-spacing:3px;">${htmlEscape(name)}</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${COLORS.green};letter-spacing:5px;padding-left:5px;">${htmlEscape(data.title || "—")}</div>
        <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:12px;color:${COLORS.dim};letter-spacing:3px;">RANK #${data.rank || 0} / ${data.totalUsers || 0}</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;width:100%;margin-top:18px;">
      <div style="display:flex;width:100%;justify-content:space-between;font-family:'SpaceMono';font-size:11px;color:${COLORS.dim};letter-spacing:3px;margin-bottom:4px;">
        <div style="display:flex;">EXP / 進 度</div>
        <div style="display:flex;">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)} (${pct}%)</div>
      </div>
      <div style="display:flex;width:100%;height:14px;background:${COLORS.bgMid};border:1px solid ${COLORS.cyan};box-sizing:border-box;">
        <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.pink};"></div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:14px;gap:10px;">
      ${statsHtml}
    </div>

    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:5px;color:${COLORS.cyan};">BADGES // ${badgesArr.length}/5</div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
