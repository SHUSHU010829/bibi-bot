// 贊助限定卡面：墨黑 + 金箔。專為抖內贈舒人 / 滿腹詩舒解鎖的卡面。
//
// Satori 限制：避免 backdrop-filter / gradient text。border 沿用 leather 的
// 雙層金框結構，加一個右上「THANK YOU」金箔印章。

const {
  fmtNumber,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
  numberToWords,
} = require("./_shared");

const COLORS = {
  bg: "#0B0B0E",
  bgInner: "#141318",
  gold: "#D4AF37",
  goldDim: "#7A6526",
  goldBright: "#F1D777",
  cream: "#F5E6C8",
  ink: "#0A0A0C",
};

function thankStamp() {
  return `
    <div style="display:flex;position:absolute;right:36px;top:34px;flex-direction:column;align-items:flex-end;">
      <div style="display:flex;border:2px solid ${COLORS.gold};padding:8px 14px;font-family:'SpaceMono';font-size:11px;letter-spacing:6px;color:${COLORS.gold};padding-right:8px;">THANK YOU</div>
      <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:500;font-size:11px;letter-spacing:6px;color:${COLORS.goldDim};padding-right:0px;">贊助限定</div>
    </div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;width:1080px;height:600px;background:${COLORS.bg};padding:14px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex:1;border:2px solid ${COLORS.gold};box-sizing:border-box;padding:6px;">
        <div style="display:flex;flex:1;position:relative;border:1px solid ${COLORS.goldDim};box-sizing:border-box;background:${COLORS.bgInner};">
          ${inner}
        </div>
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 14);
  const handle = `@${name.toUpperCase()}`;
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balance = fmtNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);
  const balanceWords = numberToWords(data.totalCoins || 0).slice(0, 60);

  const inner = `
    ${thankStamp()}

    <!-- 左上 monogram -->
    <div style="display:flex;position:absolute;left:36px;top:34px;flex-direction:column;">
      <div style="display:flex;width:68px;height:68px;border:2px solid ${COLORS.gold};background:transparent;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:32px;color:${COLORS.gold};line-height:1;padding-bottom:4px;">舒</div>
      <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.goldDim};padding-right:2px;">PATRON · ${cardNo}</div>
    </div>

    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:10px;color:${COLORS.goldDim};padding-left:10px;">— LIMITED EDITION —</div>
      <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${COLORS.cream};letter-spacing:12px;line-height:1;padding-left:12px;">贊 助 限 定 卡 面</div>

      <!-- 大餘額 -->
      <div style="display:flex;margin-top:32px;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:32px;color:${COLORS.goldDim};margin-right:8px;margin-bottom:18px;letter-spacing:2px;">NT$</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:128px;color:${COLORS.goldBright};letter-spacing:-3px;line-height:1;">${balance}</div>
      </div>

      <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:12px;letter-spacing:5px;color:${COLORS.cream};opacity:0.6;max-width:880px;text-align:center;">${htmlEscape(balanceWords)}</div>

      <div style="display:flex;margin-top:32px;width:100%;justify-content:space-between;align-items:center;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${COLORS.gold};">
        <div style="display:flex;">HOLDER · ${htmlEscape(handle)}</div>
        <div style="display:flex;">LIFETIME · ${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:120px;height:120px;object-fit:cover;border-radius:9999px;border:3px solid ${COLORS.gold};" />`
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
        <div style="display:flex;flex:1;flex-direction:column;border:1px solid ${COLORS.goldDim};padding:10px 12px;box-sizing:border-box;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.goldDim};">${s.label}</div>
          <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${COLORS.cream};line-height:1;">${htmlEscape(s.v)}</div>
        </div>
      `,
    )
    .join("");

  const inner = `
    ${thankStamp()}

    <div style="display:flex;flex:1;flex-direction:column;padding:36px 44px;">

      <!-- header -->
      <div style="display:flex;align-items:center;">
        ${avatarHtml}
        <div style="display:flex;flex-direction:column;margin-left:22px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${COLORS.cream};line-height:1.1;letter-spacing:1px;">${htmlEscape(name)}</div>
          <div style="display:flex;margin-top:8px;padding:5px 14px;background:${COLORS.gold};color:${COLORS.ink};font-family:'NotoSansTC';font-weight:500;font-size:14px;letter-spacing:4px;align-self:flex-start;">${htmlEscape(data.title || "—")}</div>
          <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:12px;letter-spacing:2px;color:${COLORS.goldDim};">RANK #${data.rank || 0} / ${data.totalUsers || 0}</div>
        </div>

        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;">
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:6px;color:${COLORS.goldDim};">LEVEL</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:96px;color:${COLORS.goldBright};line-height:1;letter-spacing:-2px;">${data.level || 0}</div>
        </div>
      </div>

      <!-- XP bar -->
      <div style="display:flex;flex-direction:column;margin-top:28px;">
        <div style="display:flex;justify-content:space-between;font-family:'SpaceMono';font-size:11px;letter-spacing:3px;color:${COLORS.goldDim};margin-bottom:6px;">
          <div style="display:flex;">EXP PROGRESS</div>
          <div style="display:flex;color:${COLORS.cream};">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)}</div>
        </div>
        <div style="display:flex;width:100%;height:18px;border:1px solid ${COLORS.goldDim};background:${COLORS.bg};box-sizing:border-box;">
          <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.gold};"></div>
        </div>
      </div>

      <!-- stats -->
      <div style="display:flex;width:100%;margin-top:24px;gap:10px;">${statsHtml}</div>

      <div style="display:flex;margin-top:auto;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.goldDim};">SHUSHU · LIMITED EDITION PATRON CARD</div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
