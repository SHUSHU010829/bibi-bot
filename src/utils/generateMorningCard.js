const getFortuneTheme = require("./getFortuneTheme");
const { renderCard } = require("./cardRenderer");

function chunkByTwo(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 2) {
    out.push(arr.slice(i, i + 2).join(" · "));
  }
  return out;
}

function buildMarkup(data) {
  const {
    theme,
    fortuneText,
    dateStr,
    lunarYearLabel,
    lunarDay,
    countdownName,
    countdownDays,
    recommends,
    avoids,
    diamondCount,
    serialNo,
  } = data;

  const recommendsLines = chunkByTwo(recommends || []);
  const avoidsItems = avoids || [];

  const hasLunar = Boolean(lunarYearLabel && lunarDay);
  const hasCountdown = Boolean(countdownName && countdownDays);

  return `
    <div style="display:flex;width:1080px;height:1080px;background:${theme.bg};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${theme.card};padding:44px 56px;box-sizing:border-box;">

        <!-- A. Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;width:100%;">
          <div style="display:flex;flex-direction:column;align-items:flex-start;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:148px;line-height:1;letter-spacing:8px;color:${theme.ink};">${fortuneText}</div>
            <div style="display:flex;margin-top:22px;padding:10px 20px;background:${theme.ink};color:${theme.card};font-weight:500;font-size:20px;letter-spacing:5px;">逼逼早報 · 吉籤我有</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;margin-top:14px;">
            <div style="display:flex;width:78px;height:78px;border-radius:9999px;background:${theme.accent};justify-content:center;align-items:center;color:${theme.card};font-family:'NotoSansTC';font-weight:900;font-size:30px;">籤</div>
            <div style="display:flex;margin-top:12px;font-family:'SpaceMono';font-size:18px;color:${theme.muted};letter-spacing:1px;">No.${serialNo}</div>
          </div>
        </div>

        <!-- B. Date band -->
        <div style="display:flex;width:100%;height:98px;margin-top:24px;background:${theme.ink};color:${theme.card};padding:0 32px;align-items:center;box-sizing:border-box;">
          <div style="display:flex;flex:1;flex-direction:column;justify-content:center;">
            <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:3px;color:${theme.muted};">GREGORIAN</div>
            <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:26px;letter-spacing:1px;">${dateStr}</div>
          </div>
          <div style="display:flex;width:1px;height:52px;background:${theme.muted};opacity:0.5;"></div>
          <div style="display:flex;flex:1;flex-direction:column;justify-content:center;padding-left:32px;">
            <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:3px;color:${theme.muted};">LUNAR · <span style="font-family:'NotoSansTC';margin-left:6px;">${lunarYearLabel || "—"}</span></div>
            <div style="display:flex;margin-top:4px;font-family:'NotoSansTC';font-weight:500;font-size:26px;letter-spacing:3px;">${lunarDay || "—"}</div>
          </div>
        </div>

        <!-- C. Countdown -->
        <div style="display:flex;width:100%;height:88px;margin-top:18px;border:2px solid ${theme.ink};padding:0 30px;align-items:center;box-sizing:border-box;">
          ${
            hasCountdown
              ? `
            <div style="display:flex;flex:1;font-family:'NotoSansTC';font-weight:500;font-size:22px;letter-spacing:5px;color:${theme.muted};">距離 ${countdownName} 還有</div>
            <div style="display:flex;align-items:baseline;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:60px;color:${theme.accent};line-height:1;">${countdownDays}</div>
              <div style="display:flex;margin-left:6px;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${theme.ink};">天</div>
            </div>
          `
              : `
            <div style="display:flex;flex:1;justify-content:center;font-family:'NotoSansTC';font-weight:500;font-size:22px;letter-spacing:5px;color:${theme.ink};">今天也是好好過日子的一天</div>
          `
          }
        </div>

        <!-- D. 宜忌 -->
        <div style="display:flex;width:100%;margin-top:20px;flex:1;gap:22px;overflow:hidden;">
          <!-- 宜 -->
          <div style="display:flex;flex:1;flex-direction:column;background:${theme.teal};color:${theme.card};padding:22px 26px;box-sizing:border-box;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:10px;border-bottom:1px solid ${theme.card};">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:36px;letter-spacing:8px;">宜</div>
              <div style="display:flex;font-family:'SpaceMono';font-size:16px;letter-spacing:4px;color:${theme.card};opacity:0.8;">DO</div>
            </div>
            <div style="display:flex;flex-direction:column;margin-top:14px;font-family:'NotoSansTC';font-weight:500;font-size:20px;letter-spacing:1px;line-height:1.55;">
              ${recommendsLines.map((l) => `<div style="display:flex;">${l}</div>`).join("")}
            </div>
          </div>
          <!-- 忌 -->
          <div style="display:flex;flex:1;flex-direction:column;background:${theme.card};border:3px solid ${theme.ink};color:${theme.ink};padding:22px 26px;box-sizing:border-box;overflow:hidden;">
            <div style="display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:10px;border-bottom:1px solid ${theme.ink};">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:36px;letter-spacing:8px;">忌</div>
              <div style="display:flex;font-family:'SpaceMono';font-size:16px;letter-spacing:4px;color:${theme.muted};">DON'T</div>
            </div>
            <div style="display:flex;flex-direction:column;margin-top:14px;font-family:'NotoSansTC';font-weight:500;font-size:20px;letter-spacing:1px;line-height:1.55;">
              ${avoidsItems.map((a) => `<div style="display:flex;">${a}</div>`).join("")}
            </div>
          </div>
        </div>

        <!-- E. Footer -->
        <div style="display:flex;flex-direction:column;width:100%;margin-top:18px;">
          <div style="display:flex;width:100%;height:1px;border-top:1px dashed ${theme.muted};"></div>
          <div style="display:flex;justify-content:center;align-items:center;margin-top:12px;font-family:'NotoSansTC';font-weight:500;font-size:22px;letter-spacing:2px;color:${theme.ink};">昨日全服挖到鑽石 <span style="font-family:'NotoSansTC';font-weight:900;font-size:26px;color:${theme.accent};margin:0 8px;">${diamondCount}</span> 顆</div>
          <div style="display:flex;justify-content:center;margin-top:10px;font-family:'SpaceMono';font-size:18px;letter-spacing:10px;color:${theme.muted};">@SHUSHU</div>
        </div>

      </div>
    </div>
  `;
}

async function generateMorningCard(data) {
  const theme = getFortuneTheme(data.fortuneText);
  const markup = buildMarkup({ ...data, theme });
  return renderCard({ markup, width: 1080, height: 1080 });
}

module.exports = generateMorningCard;
