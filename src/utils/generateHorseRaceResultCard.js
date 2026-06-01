// 賽馬結算圖卡。米色 + 3px 框,延用既有 satori 配置。

const LruCache = require("./lruCache");
const { renderCard } = require("./cardRenderer");

const cardCache = new LruCache(32);

const PALETTE = {
  card: "#F4ECD8",
  ink: "#2A2420",
  muted: "#A89270",
  rail: "#E8DFC8",
  gold: "#D4A437",
  silver: "#9AA0A6",
  bronze: "#B07A3C",
  red: "#C9302C",
  teal: "#3D6F6A",
  green: "#3F8F4F",
};

const PODIUM_HEIGHTS = { 1: 200, 2: 150, 3: 110 };
const PODIUM_COLORS = {
  1: PALETTE.gold,
  2: PALETTE.silver,
  3: PALETTE.bronze,
};
const RANK_LABEL = { 1: "1ST", 2: "2ND", 3: "3RD" };

function buildPodiumBlock(rank, horse) {
  const height = PODIUM_HEIGHTS[rank];
  const color = PODIUM_COLORS[rank];
  const safe = horse || { emoji: "—", name: "—", payout: 0 };

  return `
    <div style="display:flex;flex-direction:column;align-items:center;width:200px;margin:0 12px;">
      <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:10px;">
        <div style="display:flex;font-size:60px;line-height:1;padding-right:2px;">${safe.emoji}</div>
        <div style="display:flex;margin-top:6px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};letter-spacing:2px;line-height:1;padding-right:2px;">${safe.name}</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:16px;color:${PALETTE.muted};line-height:1;padding-right:2px;">×${safe.payout.toFixed(1)}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:200px;height:${height}px;background:${color};border:3px solid ${PALETTE.ink};box-sizing:border-box;">
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:48px;color:${PALETTE.card};line-height:1;padding-right:3px;padding-bottom:2px;">${rank}</div>
        <div style="display:flex;margin-top:4px;font-family:'SpaceMono';font-size:14px;letter-spacing:4px;color:${PALETTE.card};line-height:1;padding-right:4px;">${RANK_LABEL[rank]}</div>
      </div>
    </div>
  `;
}

function buildRankRow(horse, rank, position, trackLength) {
  const ratio = Math.max(0, Math.min(1, (position || 0) / trackLength));
  const filledWidth = Math.round(560 * ratio);
  const isTop = rank <= 3;
  const accent = rank === 1 ? PALETTE.gold : rank === 2 ? PALETTE.silver : rank === 3 ? PALETTE.bronze : PALETTE.muted;

  return `
    <div style="display:flex;width:100%;align-items:center;padding:6px 0;border-bottom:1px dashed ${PALETTE.muted};">
      <div style="display:flex;width:46px;height:30px;background:${isTop ? accent : "transparent"};border:2px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${isTop ? PALETTE.card : PALETTE.ink};line-height:1;padding-right:1px;padding-bottom:1px;">${rank}</div>
      <div style="display:flex;width:38px;font-size:28px;line-height:1;margin-left:14px;padding-right:2px;">${horse.emoji}</div>
      <div style="display:flex;width:96px;font-family:'NotoSansTC';font-weight:900;font-size:20px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${horse.name}</div>
      <div style="display:flex;width:560px;height:18px;background:${PALETTE.rail};border:2px solid ${PALETTE.ink};box-sizing:border-box;margin-left:8px;align-items:center;">
        <div style="display:flex;width:${filledWidth}px;height:100%;background:${accent};"></div>
      </div>
      <div style="display:flex;margin-left:14px;font-family:'SpaceMono';font-size:16px;color:${PALETTE.muted};line-height:1;padding-right:4px;">×${horse.payout.toFixed(1)}</div>
    </div>
  `;
}

function buildStat(label, value, color) {
  return `
    <div style="display:flex;align-items:flex-end;">
      <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">${label}</div>
      <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${color || PALETTE.ink};line-height:1;padding-right:4px;">${value}</div>
    </div>
  `;
}

function buildMarkup(data) {
  const {
    gameId,
    drawnAtLabel,
    horses,
    rankings,
    finalPositions,
    trackLength,
    pool,
    paid,
    betsCount,
  } = data;

  const horseById = new Map(horses.map((h) => [h.id, h]));
  const rankMap = new Map();
  rankings.forEach((id, i) => rankMap.set(id, i + 1));

  const champion = horseById.get(rankings[0]);
  const second = horseById.get(rankings[1]);
  const third = horseById.get(rankings[2]);

  // 順序：2nd 在左、1st 中、3rd 右,做出領獎台高低差
  const podium = [
    buildPodiumBlock(2, second),
    buildPodiumBlock(1, champion),
    buildPodiumBlock(3, third),
  ].join("");

  const sortedHorses = [...horses].sort(
    (a, b) => (rankMap.get(a.id) || 99) - (rankMap.get(b.id) || 99),
  );
  const indexById = new Map(horses.map((h, i) => [h.id, i]));
  const rankRows = sortedHorses
    .map((h) =>
      buildRankRow(
        h,
        rankMap.get(h.id) || 0,
        finalPositions[indexById.get(h.id)] ?? 0,
        trackLength,
      ),
    )
    .join("");

  const houseTook = pool - paid;
  const houseColor = houseTook >= 0 ? PALETTE.ink : PALETTE.green;

  return `
    <div style="display:flex;width:1080px;height:980px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:32px 44px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:64px;height:64px;background:${PALETTE.gold};border:3px solid ${PALETTE.ink};align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${PALETTE.card};padding-right:2px;padding-bottom:2px;">馬</div>
            <div style="display:flex;flex-direction:column;margin-left:20px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${PALETTE.ink};letter-spacing:4px;line-height:1;padding-right:6px;">賽馬大賽 ・ 結果出爐</div>
              <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;color:${PALETTE.muted};letter-spacing:3px;line-height:1;padding-right:4px;">RACE ${gameId}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;padding:8px 18px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.card};letter-spacing:3px;padding-right:21px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:18px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;width:100%;justify-content:center;align-items:flex-end;margin-top:24px;">
          ${podium}
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:24px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;flex-direction:column;width:100%;margin-top:14px;">
          ${rankRows}
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;margin-top:auto;padding-top:16px;border-top:2px dashed ${PALETTE.muted};">
          ${buildStat("POOL", pool.toLocaleString())}
          ${buildStat("PAID", paid.toLocaleString(), PALETTE.red)}
          ${buildStat("HOUSE", houseTook.toLocaleString(), houseColor)}
          ${buildStat("BETS", betsCount.toLocaleString())}
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:14px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">${drawnAtLabel ? `RACED AT ${drawnAtLabel}` : ""}</div>
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.ink};line-height:1;padding-right:5px;">@SHUSHU CASINO</div>
        </div>

      </div>
    </div>
  `;
}

function buildCacheKey(data) {
  return [
    data.gameId,
    (data.rankings || []).join(","),
    (data.finalPositions || []).join(","),
    data.pool ?? "",
    data.paid ?? "",
    data.betsCount ?? "",
  ].join("|");
}

async function generateHorseRaceResultCard(data) {
  const cacheKey = buildCacheKey(data);
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const markup = buildMarkup(data);
  const buf = await renderCard({ markup, width: 1080, height: 980 });
  cardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateHorseRaceResultCard;
