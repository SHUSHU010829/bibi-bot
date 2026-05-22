// 街頭塗鴉風格：黑底磚牆 + 螢光黃噴漆字 + 紅色陰影 + 黃膠帶旋轉貼紙
// Satori 限制：原 spec 用 Anton 體，這裡退回 NotoSansTC-Black 並加上 transform: skewX(-8deg) 模擬斜體。
//   主數字陰影：絕對定位實心紅色塊 + offset，再疊上黃色主字。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  brickA: "#1F1F1F",
  brickB: "#2A2A2A",
  yellow: "#FFD700",
  red: "#FF1744",
  white: "#F5F5F5",
  tape: "#FFC83D",
  dim: "#777777",
};

function brickWall() {
  // 6 行 x 7 列磚塊，偶數行偏移半磚
  const rowH = 100;
  const colW = 160;
  const rows = [];
  for (let r = 0; r < 6; r++) {
    const offset = r % 2 === 0 ? 0 : -colW / 2;
    const cells = [];
    for (let c = -1; c <= 7; c++) {
      const x = offset + c * colW;
      const bg = (r + c) % 2 === 0 ? COLORS.brickA : COLORS.brickB;
      cells.push(
        `<div style="display:flex;position:absolute;left:${x}px;top:${r * rowH}px;width:${colW - 4}px;height:${rowH - 4}px;background:${bg};"></div>`,
      );
    }
    rows.push(cells.join(""));
  }
  return rows.join("");
}

function ductTape({ text, x, y, rotate = 0, fontSize = 18 }) {
  return `
    <div style="display:flex;position:absolute;left:${x}px;top:${y}px;padding:6px 14px;background:${COLORS.tape};font-family:'NotoSansTC';font-weight:900;font-size:${fontSize}px;color:${COLORS.brickA};letter-spacing:2px;transform:rotate(${rotate}deg) skewX(-8deg);line-height:1;">
      ${htmlEscape(text)}
    </div>
  `;
}

// 紅影 + 黃字疊字。父層需明確寬度，避免 flex 中寬度塌成 0 → 子元素相對定位錯位。
function sprayText({ text, size = 80, letter = 0, width = "100%" }) {
  const baseStyle = `font-family:'NotoSansTC';font-weight:900;font-size:${size}px;line-height:1;letter-spacing:${letter}px;transform:skewX(-8deg);white-space:nowrap;`;
  return `
    <div style="display:flex;position:relative;width:${width};height:${size + 16}px;">
      <div style="display:flex;position:absolute;left:6px;top:6px;${baseStyle}color:${COLORS.red};opacity:0.6;">${htmlEscape(text)}</div>
      <div style="display:flex;position:absolute;left:0;top:0;${baseStyle}color:${COLORS.yellow};">${htmlEscape(text)}</div>
    </div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;position:relative;width:1080px;height:600px;background:${COLORS.brickA};font-family:'NotoSansTC';overflow:hidden;">
      ${brickWall()}
      <!-- 黑色霧化覆蓋讓字浮起來 -->
      <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:600px;background:${COLORS.brickA};opacity:0.45;"></div>
      <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:600px;padding:42px 50px;box-sizing:border-box;flex-direction:column;">
        ${inner}
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 12).toUpperCase();
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);

  // 貼紙置於 inner 結尾以保證疊在文字之上
  const stickers = `
    ${ductTape({ text: `#${cardNo}`, x: 880, y: 36, rotate: 8, fontSize: 16 })}
    ${ductTape({ text: "BANK BUSTAH", x: 60, y: 462, rotate: -3, fontSize: 18 })}
    ${ductTape({ text: "PAID", x: 880, y: 480, rotate: -1, fontSize: 18 })}
  `;

  const inner = `
    <!-- 標題：噴漆 -->
    <div style="display:flex;width:100%;flex-direction:column;">
      <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:14px;letter-spacing:6px;color:${COLORS.yellow};opacity:0.85;">— BBQ STREET / 巷 仔 內 —</div>
      <div style="display:flex;margin-top:6px;width:100%;">
        ${sprayText({ text: "錢 包 BANK!", size: 96, letter: 6 })}
      </div>
    </div>

    <!-- 主數字 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:30px;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:14px;letter-spacing:8px;color:${COLORS.white};opacity:0.7;">CASH ON HAND</div>
      <div style="display:flex;margin-top:8px;align-items:flex-end;">
        ${sprayText({ text: balance, size: 130, letter: -2 })}
      </div>
    </div>

    <!-- 底列 -->
    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.yellow};">@HOLDER</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${COLORS.white};letter-spacing:3px;transform:skewX(-8deg);">${htmlEscape(name)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.yellow};">LIFETIME</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${COLORS.white};letter-spacing:2px;">${lifetime}</div>
      </div>
    </div>
    ${stickers}
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12).toUpperCase();
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarSize = 110;
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.yellow};color:${COLORS.brickA};font-family:'NotoSansTC';font-weight:900;font-size:54px;justify-content:center;align-items:center;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "MSG", v: fmtNumber(data.totalMessages || 0) },
    { label: "VOX", v: `${data.totalVoiceMinutes || 0}m` },
    { label: "STRK", v: `${data.streak || 0}` },
    { label: "XP", v: fmtNumber(data.totalXp || 0) },
  ];
  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;background:${COLORS.brickA};border:2px solid ${COLORS.yellow};padding:8px 12px;box-sizing:border-box;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.yellow};">${s.label}</div>
          <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${COLORS.white};transform:skewX(-8deg);">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.brickA};border:2px solid ${COLORS.yellow};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.white};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.brickA};border:2px dashed ${COLORS.dim};box-sizing:border-box;opacity:0.6;"></div>
      `,
    )
    .join("");

  // 貼紙置於 inner 結尾以保證疊在文字之上
  const stickers = `
    ${ductTape({ text: `LV.${data.level || 0}`, x: 760, y: 36, rotate: -3, fontSize: 22 })}
    ${ductTape({ text: `RANK #${data.rank || 0}`, x: 880, y: 110, rotate: 8, fontSize: 16 })}
    ${ductTape({ text: `${pct}%`, x: 940, y: 540, rotate: -1, fontSize: 16 })}
  `;

  const inner = `
    <div style="display:flex;width:100%;flex-direction:column;">
      ${sprayText({ text: "等 級 LEVELZ", size: 70, letter: 4 })}
    </div>

    <div style="display:flex;width:100%;margin-top:22px;align-items:center;">
      <div style="display:flex;width:130px;height:130px;background:${COLORS.brickA};border:4px solid ${COLORS.yellow};padding:6px;box-sizing:border-box;align-items:center;justify-content:center;transform:rotate(-2deg);">
        ${avatarHtml}
      </div>
      <div style="display:flex;flex-direction:column;margin-left:22px;flex:1;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:32px;color:${COLORS.yellow};letter-spacing:3px;transform:skewX(-8deg);">${htmlEscape(name)}</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${COLORS.white};letter-spacing:4px;padding-left:4px;">${htmlEscape(data.title || "—")}</div>
        <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${COLORS.dim};">${data.totalUsers || 0} HEADS · TOP ${data.rank || 0}</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;width:100%;margin-top:18px;">
      <div style="display:flex;width:100%;justify-content:space-between;font-family:'SpaceMono';font-size:11px;color:${COLORS.yellow};letter-spacing:3px;margin-bottom:4px;">
        <div style="display:flex;">XP / 經 驗</div>
        <div style="display:flex;">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)}</div>
      </div>
      <div style="display:flex;width:100%;height:16px;background:${COLORS.brickA};border:2px solid ${COLORS.yellow};box-sizing:border-box;">
        <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.red};"></div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:14px;gap:10px;">
      ${statsHtml}
    </div>

    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:14px;letter-spacing:4px;color:${COLORS.yellow};transform:skewX(-8deg);">勳章 ${badgesArr.length}/5</div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
    ${stickers}
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
