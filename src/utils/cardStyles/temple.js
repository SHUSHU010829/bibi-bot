// 廟宇籤詩風格：米黃紙底 + 朱紅外框 + 大寫漢字數字 + 紅色印章
// Satori 限制：印章用 transform: rotate 模擬，紙質紋理用 radial-gradient 一個 spot。

const {
  fmtNumber,
  toHanNumber,
  toSimpleHan,
  xpProgress,
  avatarFallbackChar,
  htmlEscape,
  safeUsername,
} = require("./_shared");

const COLORS = {
  paper: "#F4E4C1",
  vermilion: "#C8302C",
  ink: "#3B2417",
  brown: "#6B4423",
  stamp: "#B8261F",
  paperShade: "#EAD49E",
};

function paperBg() {
  // radial-gradient 補一點紙質暗角
  return `background:${COLORS.paper};background-image:radial-gradient(circle at 30% 20%, ${COLORS.paperShade} 0%, ${COLORS.paper} 55%);`;
}

function stamp(text) {
  return `
    <div style="display:flex;width:108px;height:108px;background:${COLORS.stamp};border:4px solid ${COLORS.vermilion};color:${COLORS.paper};font-family:'NotoSansTC';font-weight:900;font-size:38px;letter-spacing:2px;line-height:1;align-items:center;justify-content:center;transform:rotate(-4deg);box-sizing:border-box;">
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-size:20px;letter-spacing:6px;padding-left:6px;">SHUSHU</div>
        <div style="display:flex;margin-top:2px;font-size:34px;letter-spacing:2px;">${htmlEscape(text)}</div>
      </div>
    </div>
  `;
}

function frame(inner) {
  return `
    <div style="display:flex;width:1080px;height:600px;${paperBg()}padding:18px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex:1;border:8px solid ${COLORS.vermilion};box-sizing:border-box;padding:6px;">
        <div style="display:flex;flex:1;border:1px solid ${COLORS.brown};box-sizing:border-box;padding:30px 40px;flex-direction:column;${paperBg()}">
          ${inner}
        </div>
      </div>
    </div>
  `;
}

function wallet(data) {
  const name = safeUsername(data.username, 12);
  const cardNo = String(data.cardNo ?? "0000").padStart(4, "0");
  const balanceHan = toHanNumber(data.totalCoins || 0);
  const lifetime = fmtNumber(data.lifetimeCoins || 0);

  const inner = `
    <!-- 標題 求 財 籤 + 印章 -->
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:78px;color:${COLORS.vermilion};letter-spacing:24px;line-height:1;padding-left:8px;">求 財 籤</div>
        <div style="display:flex;margin-top:14px;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${COLORS.brown};padding-left:2px;">SHUSHU TEMPLE — FORTUNE OF WEALTH</div>
      </div>
      ${stamp("舒")}
    </div>

    <!-- 今 日 福 報 + 大數字 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:34px;align-items:center;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${COLORS.ink};letter-spacing:18px;padding-left:18px;">今 日 福 報</div>
      <div style="display:flex;width:100%;height:0;border-top:1px solid ${COLORS.brown};margin-top:14px;opacity:0.5;"></div>
      <div style="display:flex;margin-top:18px;font-family:'NotoSansTC';font-weight:900;font-size:74px;color:${COLORS.vermilion};letter-spacing:6px;line-height:1;">${htmlEscape(balanceHan)}</div>
      <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:18px;color:${COLORS.brown};letter-spacing:6px;padding-left:6px;">${fmtNumber(data.totalCoins || 0)} CREDITS</div>
    </div>

    <!-- 簽號 + 信徒 + 累積 -->
    <div style="display:flex;width:100%;margin-top:auto;justify-content:space-between;align-items:flex-end;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${COLORS.brown};">籤號 No.</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:24px;color:${COLORS.ink};letter-spacing:4px;padding-left:4px;">${cardNo}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;letter-spacing:8px;color:${COLORS.brown};padding-left:8px;">信 徒</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${COLORS.ink};letter-spacing:2px;">${htmlEscape(name)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;">
        <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:4px;color:${COLORS.brown};">累積功德</div>
        <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${COLORS.ink};">${lifetime}</div>
      </div>
    </div>
  `;
  return frame(inner);
}

function level(data) {
  const name = safeUsername(data.username, 12);
  const levelHan = toHanNumber(data.level || 0);
  const rankHan = toSimpleHan(data.rank || 0);
  const pct = Math.round(xpProgress(data.currentLevelXp, data.xpToNextLevel) * 100);

  const avatarSize = 130;
  const avatarHtml = data.avatarDataUri
    ? `<img src="${data.avatarDataUri}" style="display:flex;width:${avatarSize}px;height:${avatarSize}px;object-fit:cover;border-radius:9999px;" />`
    : `<div style="display:flex;width:${avatarSize}px;height:${avatarSize}px;background:${COLORS.vermilion};color:${COLORS.paper};font-family:'NotoSansTC';font-weight:900;font-size:60px;justify-content:center;align-items:center;border-radius:9999px;">${avatarFallbackChar(data.username)}</div>`;

  const stats = [
    { label: "言", value: fmtNumber(data.totalMessages || 0) },
    { label: "音", value: `${data.totalVoiceMinutes || 0}` },
    { label: "勤", value: `${data.streak || 0}` },
    { label: "經", value: fmtNumber(data.totalXp || 0) },
  ];

  const statsHtml = stats
    .map(
      (s) => `
        <div style="display:flex;flex:1;flex-direction:column;align-items:center;border:1px solid ${COLORS.brown};padding:10px 6px;box-sizing:border-box;background:${COLORS.paperShade};">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${COLORS.vermilion};letter-spacing:2px;">${s.label}</div>
          <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${COLORS.ink};">${htmlEscape(s.value)}</div>
        </div>
      `,
    )
    .join("");

  const badgesArr = (data.badges || []).slice(0, 5);
  const badgePadding = Math.max(0, 5 - badgesArr.length);
  const badgeHtml = badgesArr
    .map(
      (b) => `
        <div style="display:flex;width:60px;height:60px;background:${COLORS.paperShade};border:2px solid ${COLORS.vermilion};box-sizing:border-box;justify-content:center;align-items:center;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;color:${COLORS.ink};">${htmlEscape(b.emoji || "🏅")}</div>
      `,
    )
    .join("");
  const badgePlaceholderHtml = Array(badgePadding)
    .fill(0)
    .map(
      () => `
        <div style="display:flex;width:60px;height:60px;background:transparent;border:2px dashed ${COLORS.brown};box-sizing:border-box;opacity:0.45;"></div>
      `,
    )
    .join("");

  const inner = `
    <!-- 標題 修 行 籙 + 印章 -->
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-start;">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:64px;color:${COLORS.vermilion};letter-spacing:22px;line-height:1;padding-left:8px;">修 行 籙</div>
        <div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${COLORS.brown};">SCROLL OF CULTIVATION — RANK ${rankHan} / ${toSimpleHan(data.totalUsers || 0)}</div>
      </div>
      ${stamp("行")}
    </div>

    <!-- 上半：頭像 + 階級 -->
    <div style="display:flex;width:100%;margin-top:24px;align-items:center;">
      <div style="display:flex;width:140px;height:140px;border:3px solid ${COLORS.vermilion};padding:5px;box-sizing:border-box;border-radius:9999px;align-items:center;justify-content:center;">
        ${avatarHtml}
      </div>
      <div style="display:flex;flex-direction:column;margin-left:24px;flex:1;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:32px;color:${COLORS.ink};letter-spacing:2px;">${htmlEscape(name)}</div>
        <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${COLORS.brown};letter-spacing:6px;padding-left:6px;">${htmlEscape(data.title || "—")}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${COLORS.brown};letter-spacing:6px;padding-left:6px;">第　階</div>
        <div style="display:flex;margin-top:2px;font-family:'NotoSansTC';font-weight:900;font-size:54px;color:${COLORS.vermilion};line-height:1;letter-spacing:2px;">${htmlEscape(levelHan)}</div>
      </div>
    </div>

    <!-- 進度條 -->
    <div style="display:flex;flex-direction:column;width:100%;margin-top:18px;">
      <div style="display:flex;width:100%;justify-content:space-between;font-family:'SpaceMono';font-size:12px;color:${COLORS.brown};letter-spacing:2px;margin-bottom:4px;">
        <div style="display:flex;">道 行 ${fmtNumber(data.currentLevelXp || 0)} / ${fmtNumber(data.xpToNextLevel || 0)}</div>
        <div style="display:flex;">${pct}%</div>
      </div>
      <div style="display:flex;width:100%;height:14px;background:${COLORS.paperShade};border:1px solid ${COLORS.brown};box-sizing:border-box;">
        <div style="display:flex;width:${pct}%;height:100%;background:${COLORS.vermilion};"></div>
      </div>
    </div>

    <!-- 統計四格 -->
    <div style="display:flex;width:100%;margin-top:14px;gap:10px;">
      ${statsHtml}
    </div>

    <!-- 功德印章（徽章） -->
    <div style="display:flex;width:100%;margin-top:auto;align-items:center;justify-content:space-between;">
      <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:14px;letter-spacing:6px;color:${COLORS.brown};padding-left:6px;">功 德 印 ${badgesArr.length}/5</div>
      <div style="display:flex;gap:8px;">
        ${badgeHtml}${badgePlaceholderHtml}
      </div>
    </div>
  `;
  return frame(inner);
}

module.exports = { wallet, level, COLORS };
