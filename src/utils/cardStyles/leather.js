// 皮革撲克風格：深咖啡 + 燙金邊框 + 撲克牌四角佈局 + 中央大圖騰
// Satori 限制：右下角元素需要用 transform: rotate(180deg) 反轉。
//   橢圓頭像框：borderRadius: 50% + 寬高比 100:120。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
  numberToWords,
} = require("./_shared");

const COLORS = {
  bg: "#5C2317",
  bgDark: "#3F1810",
  gold: "#D4A24C",
  goldDim: "#8C6A30",
  cream: "#F2E2BD",
  ink: "#1A0A05",
};

function pokerCorner({ suit, position }) {
  const wrapStyle = position === "bottom-right"
    ? "position:absolute;right:28px;bottom:28px;transform:rotate(180deg);"
    : "position:absolute;left:28px;top:28px;";
  return `
    <div style="display:flex;${wrapStyle}flex-direction:column;align-items:center;">
      <div style="display:flex;font-family:'SpaceMono';font-size:44px;color:${COLORS.gold};line-height:1;">${htmlEscape(suit)}</div>
    </div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;width:1080px;height:600px;background:${COLORS.bg};padding:14px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex:1;border:2px solid ${COLORS.gold};box-sizing:border-box;padding:6px;">
        <div style="display:flex;flex:1;position:relative;border:1px solid ${COLORS.goldDim};box-sizing:border-box;background:${COLORS.bg};">
          ${inner}
        </div>
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 14);
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);
  const balanceWords = numberToWords(data.totalCoins || 0).slice(0, 60);

  const inner = `
    ${pokerCorner({ suit: "♠", position: "top-left" })}
    ${pokerCorner({ suit: "♠", position: "bottom-right" })}

    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:8px;color:${COLORS.gold};padding-left:8px;">— SHUSHU CASINO ROYALE —</div>
      <div style="display:flex;margin-top:10px;font-family:'NotoSansTC';font-weight:900;font-size:54px;color:${COLORS.cream};letter-spacing:14px;line-height:1;padding-left:14px;">皮 革 錢 包</div>

      <!-- 中央燙金圖騰圈 -->
      <div style="display:flex;width:88px;height:88px;margin-top:18px;border:2px solid ${COLORS.gold};border-radius:9999px;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${COLORS.gold};">幣</div>

      <div style="display:flex;margin-top:14px;font-family:'SpaceMono';font-size:11px;letter-spacing:6px;color:${COLORS.goldDim};">CHIPS · ${cardNo}</div>

      <div style="display:flex;margin-top:14px;font-family:'NotoSansTC';font-weight:900;font-size:96px;color:${COLORS.gold};letter-spacing:-2px;line-height:1;">${balance}</div>
      <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:12px;letter-spacing:5px;color:${COLORS.cream};opacity:0.75;max-width:780px;">${htmlEscape(balanceWords)}</div>

      <div style="display:flex;margin-top:24px;width:100%;justify-content:space-between;align-items:center;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${COLORS.gold};">
        <div style="display:flex;">HOLDER · ${htmlEscape(name)}</div>
        <div style="display:flex;">LIFETIME · ${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  // 正圓頭像（120x120）
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:120px;height:120px;object-fit:cover;border-radius:9999px;" />`
    : `<div style="display:flex;width:120px;height:120px;background:${COLORS.gold};color:${COLORS.ink};font-family:'NotoSansTC';font-weight:900;font-size:56px;justify-content:center;align-items:center;border-radius:9999px;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "MSG", v: fmtNumber(data.totalMessages || 0) },
    { label: "VOICE", v: `${data.totalVoiceMinutes || 0}m` },
    { label: "STREAK", v: `${data.streak || 0}` },
    { label: "XP", v: fmtNumber(data.totalXp || 0) },
  ];
  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;border:1px solid ${COLORS.goldDim};padding:12px 14px;box-sizing:border-box;background:${COLORS.bgDark};">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.gold};">${s.label}</div>
          <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${COLORS.cream};">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:62px;height:62px;background:${COLORS.bgDark};border:2px solid ${COLORS.gold};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.cream};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:62px;height:62px;background:transparent;border:2px dashed ${COLORS.goldDim};box-sizing:border-box;opacity:0.5;"></div>
      `,
    )
    .join("");

  const inner = `
    ${pokerCorner({ suit: "♠", position: "top-left" })}
    ${pokerCorner({ suit: "♠", position: "bottom-right" })}

    <div style="display:flex;flex:1;flex-direction:column;padding:48px 80px;">
      <div style="display:flex;width:100%;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;">
          <div style="display:flex;border:2px solid ${COLORS.gold};padding:5px;box-sizing:border-box;border-radius:9999px;">
            ${avatarHtml}
          </div>
          <div style="display:flex;flex-direction:column;margin-left:24px;">
            <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:6px;color:${COLORS.gold};">PLAYER</div>
            <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:40px;color:${COLORS.cream};letter-spacing:2px;line-height:1.1;">${htmlEscape(name)}</div>
            <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${COLORS.gold};letter-spacing:4px;padding-left:4px;">${htmlEscape(data.title || "—")}</div>
            <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;letter-spacing:2px;color:${COLORS.goldDim};">RANK #${data.rank || 0} / ${data.totalUsers || 0}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:6px;color:${COLORS.gold};">LEVEL</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:104px;color:${COLORS.gold};line-height:1;">${data.level || 0}</div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;width:100%;margin-top:24px;">
        <div style="display:flex;width:100%;justify-content:space-between;font-family:'SpaceMono';font-size:14px;color:${COLORS.gold};letter-spacing:3px;margin-bottom:6px;">
          <div style="display:flex;">EXP / 經驗</div>
          <div style="display:flex;">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)} (${pct}%)</div>
        </div>
        <div style="display:flex;width:100%;height:14px;background:${COLORS.bgDark};border:1px solid ${COLORS.goldDim};box-sizing:border-box;">
          <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.gold};"></div>
        </div>
      </div>

      <div style="display:flex;width:100%;margin-top:16px;gap:10px;">
        ${statsHtml}
      </div>

      <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
        <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.gold};">BADGES ${badgesArr.length}/5</div>
        <div style="display:flex;gap:8px;">
          ${badgeHtml}${badgePlaceholderHtml}
        </div>
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
