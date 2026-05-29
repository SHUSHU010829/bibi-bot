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
  goldShine: "#FBEFC0",
  cream: "#F5E6C8",
  ink: "#0A0A0C",
};

// 燙金漸層：外框 / 印章 / monogram 共用，模擬金箔反光。
const GOLD_GRAD = `linear-gradient(135deg, ${COLORS.goldShine} 0%, ${COLORS.gold} 28%, ${COLORS.goldDim} 50%, ${COLORS.gold} 72%, ${COLORS.goldShine} 100%)`;

// 皇冠 icon：內嵌 SVG（字型沒有 ♔ glyph，改用向量保證渲染、不依賴網路）。
// fill 可帶入金或墨黑，做出燙金 / 雕刻效果。
function crownImg(fill, size) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="${fill}" d="M12 80 L12 60 L26 30 L39 50 L50 22 L61 50 L74 30 L88 60 L88 80 Z"/><circle cx="26" cy="28" r="5" fill="${fill}"/><circle cx="50" cy="20" r="5" fill="${fill}"/><circle cx="74" cy="28" r="5" fill="${fill}"/></svg>`;
  const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<img src="${uri}" style="display:flex;width:${size}px;height:${size}px;" />`;
}

// 黑卡雕刻金屬底紋：極淡的金色斜向髮絲線（guilloché 感）。
function metalTexture() {
  return `<div style="display:flex;position:absolute;left:0;top:0;right:0;bottom:0;background-image:repeating-linear-gradient(45deg, rgba(212,175,55,0.05) 0px, rgba(212,175,55,0.05) 1px, rgba(0,0,0,0) 1px, rgba(0,0,0,0) 9px);"></div>`;
}

// 浮雕卡號：取 userId 數字尾段，套 AmEx 4-6-5 分組。
function cardNumberFrom(userId) {
  const d = String(userId || "")
    .replace(/\D/g, "")
    .padStart(15, "3")
    .slice(-15);
  return `${d.slice(0, 4)} ${d.slice(4, 10)} ${d.slice(10)}`;
}

function thankStamp() {
  return `
    <div style="display:flex;position:absolute;right:36px;top:34px;flex-direction:column;align-items:flex-end;">
      <div style="display:flex;border:1px solid ${COLORS.goldShine};background-image:${GOLD_GRAD};padding:8px 14px;font-family:'SpaceMono';font-size:11px;letter-spacing:6px;color:${COLORS.ink};padding-right:8px;">THANK YOU</div>
      <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:500;font-size:11px;letter-spacing:6px;color:${COLORS.goldBright};padding-right:0px;">贊助限定</div>
    </div>
  `;
}

// 四角燙金框飾：每個角只畫相鄰兩邊，形成 L 形包角。
function cornerOrnaments() {
  const mk = (pos, borders) =>
    `<div style="display:flex;position:absolute;${pos}width:20px;height:20px;${borders}"></div>`;
  return `
    ${mk("left:13px;top:13px;", `border-left:2px solid ${COLORS.goldShine};border-top:2px solid ${COLORS.goldShine};`)}
    ${mk("right:13px;top:13px;", `border-right:2px solid ${COLORS.goldShine};border-top:2px solid ${COLORS.goldShine};`)}
    ${mk("left:13px;bottom:13px;", `border-left:2px solid ${COLORS.goldShine};border-bottom:2px solid ${COLORS.goldShine};`)}
    ${mk("right:13px;bottom:13px;", `border-right:2px solid ${COLORS.goldShine};border-bottom:2px solid ${COLORS.goldShine};`)}
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;width:1080px;height:600px;background:${COLORS.bg};background-image:radial-gradient(circle at 50% 16%, #1d160c 0%, ${COLORS.bg} 62%);padding:14px;box-sizing:border-box;font-family:'NotoSansTC';">
      <!-- 漸層燙金外框（以 padding 露出底層 gradient 當邊） -->
      <div style="display:flex;flex:1;padding:3px;box-sizing:border-box;background-image:${GOLD_GRAD};">
        <div style="display:flex;flex:1;padding:5px;box-sizing:border-box;background:${COLORS.bg};">
          <div style="display:flex;flex:1;position:relative;border:1px solid ${COLORS.gold};box-sizing:border-box;background:${COLORS.bgInner};background-image:radial-gradient(circle at 50% 30%, #241c0e 0%, ${COLORS.bgInner} 60%);">
            ${metalTexture()}
            ${cornerOrnaments()}
            ${inner}
          </div>
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
  const cardNumber = cardNumberFrom(data.userId);

  const inner = `
    ${thankStamp()}

    <!-- 左上 monogram -->
    <div style="display:flex;position:absolute;left:36px;top:34px;flex-direction:column;">
      <div style="display:flex;width:68px;height:68px;border:1px solid ${COLORS.goldShine};background-image:${GOLD_GRAD};align-items:center;justify-content:center;">${crownImg(COLORS.ink, 40)}</div>
      <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:11px;letter-spacing:4px;color:${COLORS.goldDim};padding-right:2px;">PATRON · ${cardNo}</div>
    </div>

    <div style="display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:0 60px;">
      <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:10px;color:${COLORS.goldDim};padding-left:10px;">— LIMITED EDITION —</div>

      <!-- 贊助限定徽章 -->
      <div style="display:flex;margin-top:14px;align-items:center;border:1px solid ${COLORS.gold};padding:10px 26px;background-image:linear-gradient(180deg, rgba(212,175,55,0.14) 0%, rgba(212,175,55,0) 100%);">
        ${crownImg(COLORS.goldBright, 26)}
        <div style="display:flex;margin:0 18px;font-family:'NotoSansTC';font-weight:900;font-size:28px;letter-spacing:8px;color:${COLORS.goldShine};padding-left:8px;">贊助限定</div>
        ${crownImg(COLORS.goldBright, 26)}
      </div>

      <!-- 大餘額 -->
      <div style="display:flex;margin-top:32px;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:32px;color:${COLORS.goldDim};margin-right:8px;margin-bottom:18px;letter-spacing:2px;">NT$</div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:128px;color:${COLORS.goldShine};letter-spacing:-3px;line-height:1;">${balance}</div>
      </div>

      <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:12px;letter-spacing:5px;color:${COLORS.cream};opacity:0.6;max-width:880px;text-align:center;">${htmlEscape(balanceWords)}</div>

      <!-- 浮雕卡號 -->
      <div style="display:flex;margin-top:26px;font-family:'SpaceMono';font-weight:700;font-size:30px;letter-spacing:8px;color:${COLORS.cream};padding-left:8px;">${cardNumber}</div>

      <!-- 信用卡式三欄資訊 -->
      <div style="display:flex;margin-top:22px;width:100%;justify-content:space-between;align-items:flex-end;">
        <div style="display:flex;flex-direction:column;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.goldDim};margin-bottom:4px;">CARD HOLDER</div>
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.gold};">${htmlEscape(handle)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.goldDim};margin-bottom:4px;">LIFETIME</div>
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:3px;color:${COLORS.gold};">NT$ ${lifetime}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;">
          <div style="display:flex;font-family:'SpaceMono';font-size:10px;letter-spacing:3px;color:${COLORS.goldDim};margin-bottom:4px;">VALID THRU</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:15px;letter-spacing:2px;color:${COLORS.goldBright};">∞ 永久</div>
        </div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:120px;height:120px;object-fit:cover;border-radius:9999px;border:3px solid ${COLORS.goldShine};" />`
    : `<div style="display:flex;width:120px;height:120px;background-image:${GOLD_GRAD};color:${COLORS.ink};font-family:'NotoSansTC';font-weight:900;font-size:56px;justify-content:center;align-items:center;border-radius:9999px;">${avatarFallbackChar(data.username)}</div>`;

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
    <div style="display:flex;flex:1;flex-direction:column;padding:36px 44px;">

      <!-- header -->
      <div style="display:flex;align-items:center;">
        ${avatarHtml}
        <div style="display:flex;flex-direction:column;margin-left:22px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${COLORS.cream};line-height:1.1;letter-spacing:1px;">${htmlEscape(name)}</div>
          <div style="display:flex;margin-top:8px;padding:5px 14px;background-image:${GOLD_GRAD};color:${COLORS.ink};font-family:'NotoSansTC';font-weight:500;font-size:14px;letter-spacing:4px;align-self:flex-start;">${htmlEscape(data.title || "—")}</div>
          <div style="display:flex;margin-top:8px;font-family:'SpaceMono';font-size:12px;letter-spacing:2px;color:${COLORS.goldDim};">RANK #${data.rank || 0} / ${data.totalUsers || 0}</div>
        </div>

        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;">
          <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:6px;color:${COLORS.goldDim};">LEVEL</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:96px;color:${COLORS.goldShine};line-height:1;letter-spacing:-2px;">${data.level || 0}</div>
        </div>
      </div>

      <!-- XP bar -->
      <div style="display:flex;flex-direction:column;margin-top:28px;">
        <div style="display:flex;justify-content:space-between;font-family:'SpaceMono';font-size:11px;letter-spacing:3px;color:${COLORS.goldDim};margin-bottom:6px;">
          <div style="display:flex;">EXP PROGRESS</div>
          <div style="display:flex;color:${COLORS.cream};">${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)}</div>
        </div>
        <div style="display:flex;width:100%;height:18px;border:1px solid ${COLORS.goldDim};background:${COLORS.bg};box-sizing:border-box;">
          <div style="display:flex;width:${pct}%;height:100%;background-image:${GOLD_GRAD};"></div>
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
