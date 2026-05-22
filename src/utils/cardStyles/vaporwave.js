// 蒸汽波風格：深紫底 + 條紋粉紅太陽 + 青藍透視網格地平線 + 半中半英
// Satori 限制：clip-path 不支援 → 條紋太陽用一個圓 + 多條黑色橫條覆蓋。
//   transformOrigin + rotate 模擬透視輻射線。
//   菱形頭像框：外層 rotate(45deg) + 內層 rotate(-45deg) 抵銷。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  bg: "#0D0221",
  pink: "#FF71CE",
  cyan: "#01CDFE",
  yellow: "#FFFB96",
  ink: "#F8E8FF",
  dim: "#6B4B8A",
  bgDark: "#150434",
};

function stripedSun({ size = 220, x = 700, y = 30 }) {
  // 圓形 + 8 條黑色橫條切割
  const stripes = [];
  const stripeH = 8;
  const gap = Math.floor(size / 9);
  for (let i = 1; i <= 7; i++) {
    const top = i * gap;
    stripes.push(
      `<div style="display:flex;position:absolute;left:0;top:${top}px;width:${size}px;height:${stripeH}px;background:${COLORS.bg};"></div>`,
    );
  }
  return `
    <div style="display:flex;position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;border-radius:9999px;background:${COLORS.pink};">
      ${stripes.join("")}
    </div>
  `;
}

function gridFloor({ top = 380 }) {
  // 4 條水平線 (透視壓縮：越下越密)
  const horizons = [
    { y: 0, op: 0.4 }, { y: 30, op: 0.55 }, { y: 75, op: 0.7 }, { y: 140, op: 0.9 },
  ];
  const hLines = horizons
    .map(
      (h) => `<div style="display:flex;position:absolute;left:0;top:${h.y}px;width:1080px;height:1px;background:${COLORS.cyan};opacity:${h.op};"></div>`,
    )
    .join("");

  // 9 條輻射線：以 (540, 0) 為消失點，使用 transformOrigin: top
  const radials = [];
  for (let i = -4; i <= 4; i++) {
    const angle = i * 14;
    radials.push(
      `<div style="display:flex;position:absolute;left:540px;top:0;width:1px;height:240px;background:${COLORS.cyan};opacity:0.5;transform-origin:top;transform:rotate(${angle}deg);"></div>`,
    );
  }

  return `
    <div style="display:flex;position:absolute;left:0;top:${top}px;width:1080px;height:240px;">
      ${hLines}
      ${radials.join("")}
    </div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;position:relative;width:1080px;height:600px;background:${COLORS.bg};font-family:'NotoSansTC';">
      ${stripedSun({ size: 240, x: 760, y: 40 })}
      ${gridFloor({ top: 360 })}
      <div style="display:flex;position:absolute;left:0;top:0;width:1080px;height:600px;padding:38px 46px;box-sizing:border-box;flex-direction:column;">
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
    <div style="display:flex;width:100%;flex-direction:column;">
      <div style="display:flex;font-family:'NotoSansJP';font-weight:500;font-size:18px;letter-spacing:14px;color:${COLORS.cyan};padding-left:14px;">A E S T H E T I C</div>
      <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:64px;color:${COLORS.pink};letter-spacing:18px;line-height:1;padding-left:18px;">蒸 氣 錢 包</div>
      <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${COLORS.ink};opacity:0.75;">VAPOR.WALLET // CARD NO. ${cardNo}</div>
    </div>

    <!-- 大數字 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:50px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:8px;color:${COLORS.cyan};padding-left:8px;">CURRENT BALANCE / 現 在 餘 額</div>
      <div style="display:flex;align-items:flex-end;margin-top:6px;">
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:140px;color:${COLORS.yellow};letter-spacing:-2px;line-height:1;">${balance}</div>
        <div style="display:flex;margin-left:18px;margin-bottom:18px;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${COLORS.pink};letter-spacing:8px;padding-left:8px;">クレジット</div>
      </div>
    </div>

    <!-- 底列 -->
    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:5px;color:${COLORS.cyan};">HOLDER</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:28px;color:${COLORS.ink};letter-spacing:4px;padding-left:4px;">${htmlEscape(name)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:5px;color:${COLORS.cyan};">LIFETIME</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-weight:700;font-size:24px;color:${COLORS.pink};letter-spacing:2px;">${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  // 菱形頭像：外層 rotate 45deg + 內層 rotate -45deg 抵銷
  const avatarSize = 100;
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;transform:rotate(-45deg);" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.pink};color:${COLORS.bg};font-family:'NotoSansTC';font-weight:900;font-size:48px;justify-content:center;align-items:center;transform:rotate(-45deg);">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "メッセージ", v: fmtNumber(data.totalMessages || 0) },
    { label: "VOICE", v: `${data.totalVoiceMinutes || 0}m` },
    { label: "連續", v: `${data.streak || 0}` },
    { label: "XP", v: fmtNumber(data.totalXp || 0) },
  ];
  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;padding:8px 12px;border:1px solid ${COLORS.pink};box-sizing:border-box;">
          <div style="display:flex;font-family:'NotoSansJP';font-weight:500;font-size:11px;color:${COLORS.cyan};letter-spacing:3px;">${s.label}</div>
          <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${COLORS.yellow};">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.bgDark};border:2px solid ${COLORS.cyan};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.ink};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:transparent;border:2px dashed ${COLORS.pink};box-sizing:border-box;opacity:0.45;"></div>
      `,
    )
    .join("");

  const inner = `
    <div style="display:flex;width:100%;flex-direction:column;">
      <div style="display:flex;font-family:'NotoSansJP';font-weight:500;font-size:16px;letter-spacing:12px;color:${COLORS.cyan};padding-left:12px;">P R O F I L E</div>
      <div style="display:flex;margin-top:2px;font-family:'NotoSansTC';font-weight:900;font-size:50px;color:${COLORS.pink};letter-spacing:14px;line-height:1;padding-left:14px;">蒸 氣 等 級</div>
    </div>

    <div style="display:flex;width:100%;margin-top:30px;align-items:center;">
      <!-- 菱形頭像 -->
      <div style="display:flex;width:140px;height:140px;align-items:center;justify-content:center;">
        <div style="display:flex;width:100px;height:100px;background:${COLORS.bgDark};border:2px solid ${COLORS.cyan};box-sizing:border-box;align-items:center;justify-content:center;transform:rotate(45deg);">
          ${avatarHtml}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;margin-left:18px;flex:1;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${COLORS.ink};letter-spacing:4px;">${htmlEscape(name)}</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansJP';font-weight:500;font-size:14px;color:${COLORS.pink};letter-spacing:6px;padding-left:6px;">${htmlEscape(data.title || "—")}</div>
        <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:12px;color:${COLORS.cyan};letter-spacing:3px;">RANK #${data.rank || 0} / ${data.totalUsers || 0}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-family:'SpaceMono';font-size:11px;letter-spacing:6px;color:${COLORS.cyan};">LV</div>
        <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:90px;color:${COLORS.yellow};line-height:1;">${data.level || 0}</div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;width:100%;margin-top:18px;">
      <div style="display:flex;justify-content:space-between;width:100%;font-family:'SpaceMono';font-size:11px;color:${COLORS.cyan};letter-spacing:3px;margin-bottom:4px;">
        <div style="display:flex;">EXP / 經 驗 值</div>
        <div style="display:flex;">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)} (${pct}%)</div>
      </div>
      <div style="display:flex;width:100%;height:14px;background:${COLORS.bgDark};border:1px solid ${COLORS.pink};box-sizing:border-box;">
        <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.pink};"></div>
      </div>
    </div>

    <div style="display:flex;width:100%;margin-top:14px;gap:10px;">
      ${statsHtml}
    </div>

    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'NotoSansJP';font-weight:500;font-size:12px;letter-spacing:6px;color:${COLORS.cyan};padding-left:6px;">バッジ ${badgesArr.length}/5</div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
