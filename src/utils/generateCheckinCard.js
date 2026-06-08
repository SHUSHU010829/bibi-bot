const { DateTime } = require("luxon");

const LruCache = require("./lruCache");
const { renderCard, fetchAvatarDataUri } = require("./cardRenderer");

const checkinCardCache = new LruCache(256);

function buildCalendar(today, timezone, checkinDates, makeupDates) {
  const cells = [];
  for (let i = 29; i >= 0; i--) {
    const d = DateTime.fromISO(today, { zone: timezone })
      .minus({ days: i })
      .toISODate();
    cells.push({
      date: d,
      checked: checkinDates.has(d),
      makeup: makeupDates?.has(d) || false,
      isToday: i === 0,
    });
  }
  return cells;
}

function buildMarkup(data) {
  const {
    username,
    avatarDataUri,
    streak,
    totalCheckins,
    xpEarned,
    multiplier,
    afterLevel,
    today,
    timezone,
    checkinDates,
    makeupDates,
  } = data;

  const ink = "#2A2420";
  const card = "#F4ECD8";
  const accent = "#C9302C";
  const muted = "#A89270";
  const subtle = "#E8DFC8";
  const teal = "#3D6F6A";
  const makeup = "#D4A24C";

  const cells = buildCalendar(today, timezone, checkinDates, makeupDates);

  // 5 列 × 6 欄 = 30 格（橫向排版避免吃高度）
  const calendarRows = [];
  for (let r = 0; r < 5; r++) {
    calendarRows.push(cells.slice(r * 6, r * 6 + 6));
  }

  const CELL = 64;
  const renderCell = (cell) => {
    if (cell.isToday) {
      // 今天：紅色填滿 + 內外雙框，視覺最強
      return `<div style="display:flex;width:${CELL}px;height:${CELL}px;background:${accent};border:4px solid ${ink};box-sizing:border-box;"></div>`;
    }
    if (cell.checked) {
      return `<div style="display:flex;width:${CELL}px;height:${CELL}px;background:${teal};box-sizing:border-box;"></div>`;
    }
    if (cell.makeup) {
      return `<div style="display:flex;width:${CELL}px;height:${CELL}px;background:${makeup};border:2px dashed ${ink};box-sizing:border-box;"></div>`;
    }
    return `<div style="display:flex;width:${CELL}px;height:${CELL}px;background:${subtle};border:1px solid ${muted};box-sizing:border-box;"></div>`;
  };

  const calendarHtml = calendarRows
    .map(
      (row) => `
        <div style="display:flex;gap:8px;">
          ${row.map(renderCell).join("")}
        </div>`
    )
    .join("");

  const avatarHtml = avatarDataUri
    ? `<img src="${avatarDataUri}" style="display:flex;width:88px;height:88px;object-fit:cover;border:3px solid ${ink};" />`
    : `<div style="display:flex;width:88px;height:88px;background:${ink};color:${card};font-family:'NotoSansTC';font-weight:900;font-size:40px;justify-content:center;align-items:center;border:3px solid ${ink};">${(username || "?").charAt(0).toUpperCase()}</div>`;

  const bonusHtml =
    multiplier > 1
      ? `<div style="display:flex;margin-top:10px;padding:6px 18px;background:${accent};color:${card};font-family:'NotoSansTC';font-weight:900;font-size:18px;letter-spacing:6px;">CHAIN BONUS x${multiplier}</div>`
      : `<div style="display:flex;margin-top:10px;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${muted};">CONNECT 7 DAYS · UNLOCK x1.5</div>`;

  return `
    <div style="display:flex;width:1080px;height:900px;background:${card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${card};border:3px solid ${ink};padding:30px 56px;box-sizing:border-box;">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;width:100%;">
          <div style="display:flex;align-items:center;">
            ${avatarHtml}
            <div style="display:flex;flex-direction:column;margin-left:18px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${ink};line-height:1.1;">${username}</div>
              <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;letter-spacing:2px;color:${muted};">DAILY CHECK-IN</div>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:3px;color:${muted};">DATE</div>
            <div style="display:flex;font-family:'SpaceMono';font-size:24px;color:${ink};">${today}</div>
          </div>
        </div>

        <!-- Streak block -->
        <div style="display:flex;flex-direction:column;align-items:center;width:100%;margin-top:14px;padding:12px 0 14px 0;background:${ink};color:${card};">
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:10px;color:${muted};">— STREAK —</div>
          <div style="display:flex;align-items:baseline;margin-top:2px;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:88px;color:${accent};line-height:1;">${streak}</div>
            <div style="display:flex;margin-left:14px;font-family:'NotoSansTC';font-weight:500;font-size:28px;color:${card};">天</div>
          </div>
          ${bonusHtml}
        </div>

        <!-- Calendar -->
        <div style="display:flex;flex-direction:column;width:100%;margin-top:14px;align-items:center;">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:6px;color:${muted};">— LAST 30 DAYS —</div>
          <div style="display:flex;flex-direction:column;margin-top:10px;gap:8px;">
            ${calendarHtml}
          </div>
          <div style="display:flex;margin-top:14px;margin-bottom:14px;gap:18px;font-family:'SpaceMono';font-size:11px;letter-spacing:2px;color:${muted};">
            <div style="display:flex;align-items:center;"><div style="display:flex;width:14px;height:14px;background:${accent};margin-right:6px;"></div>TODAY</div>
            <div style="display:flex;align-items:center;"><div style="display:flex;width:14px;height:14px;background:${teal};margin-right:6px;"></div>CHECKED</div>
            <div style="display:flex;align-items:center;"><div style="display:flex;width:14px;height:14px;background:${makeup};border:2px dashed ${ink};margin-right:6px;box-sizing:border-box;"></div>MAKEUP</div>
            <div style="display:flex;align-items:center;"><div style="display:flex;width:14px;height:14px;background:${subtle};border:1px solid ${muted};margin-right:6px;"></div>MISSED</div>
          </div>
        </div>

        <!-- Footer summary -->
        <div style="display:flex;width:100%;margin-top:auto;padding-top:24px;border-top:1px dashed ${muted};justify-content:space-between;align-items:center;">
          <div style="display:flex;flex-direction:column;">
            <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${muted};">XP EARNED</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${accent};">+${xpEarned}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:center;">
            <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${muted};">TOTAL CHECK-INS</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${ink};">${totalCheckins}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:12px;letter-spacing:3px;color:${muted};">CURRENT LEVEL</div>
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${ink};">${afterLevel ?? "-"}</div>
          </div>
        </div>

      </div>
    </div>
  `;
}

function buildCacheKey(data) {
  const dates = data.checkinDates
    ? [...data.checkinDates].sort().join(",")
    : "";
  const makeup = data.makeupDates
    ? [...data.makeupDates].sort().join(",")
    : "";
  return [
    data.userId || data.username || "",
    data.today || "",
    data.streak ?? "",
    data.totalCheckins ?? "",
    data.xpEarned ?? "",
    data.multiplier ?? "",
    data.afterLevel ?? "",
    dates,
    makeup,
  ].join("|");
}

async function generateCheckinCard(data) {
  const cacheKey = buildCacheKey(data);
  const cached = checkinCardCache.get(cacheKey);
  if (cached) return cached;

  const avatarDataUri = await fetchAvatarDataUri(data.avatarUrl);
  const markup = buildMarkup({ ...data, avatarDataUri });

  const buf = await renderCard({ markup, width: 1080, height: 900 });
  checkinCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateCheckinCard;
