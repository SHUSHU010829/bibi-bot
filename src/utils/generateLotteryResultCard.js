// 樂透開獎結果圖卡。米色 + 3px 框,延用既有 satori 配置。

const LruCache = require("./lruCache");
const { renderCard } = require("./cardRenderer");

const cardCache = new LruCache(32);

const PALETTE = {
  card: "#F4ECD8",
  ink: "#2A2420",
  muted: "#A89270",
  reelBg: "#E8DFC8",
  gold: "#D4A437",
  red: "#C9302C",
  teal: "#3D6F6A",
  orange: "#D94C2A",
};

function renderBall(num, color) {
  return `
    <div style="display:flex;width:78px;height:78px;background:${color};border:3px solid ${PALETTE.ink};box-sizing:border-box;align-items:center;justify-content:center;margin:0 8px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.card};line-height:1;padding-right:1px;padding-bottom:2px;">${num}</div>
  `;
}

function buildPrizeRow(label, count, perWinner, color) {
  let winnerStr;
  if (count <= 0) {
    winnerStr = "從缺";
  } else if (perWinner <= 0) {
    // 有人對中但獎金已隨頭獎從缺滾入下期
    winnerStr = "從缺(滾入下期)";
  } else {
    winnerStr = `${count} 位 × ${perWinner.toLocaleString()}`;
  }
  return `
    <div style="display:flex;width:100%;justify-content:space-between;align-items:flex-end;padding:6px 0;border-bottom:1px dashed ${PALETTE.muted};">
      <div style="display:flex;align-items:flex-end;">
        <div style="display:flex;width:14px;height:14px;background:${color};margin-right:12px;margin-bottom:4px;"></div>
        <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${label}</div>
      </div>
      <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:20px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${winnerStr}</div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function formatWinnersLine(names) {
  if (!names || names.length === 0) return "";
  const MAX_SHOWN = 4;
  const shown = names.slice(0, MAX_SHOWN);
  const rest = names.length - shown.length;
  const base = shown.map(escapeHtml).join("、");
  return rest > 0 ? `${base} 等 ${names.length} 位` : base;
}

function buildMarkup(data) {
  const {
    lotteryType,
    drawId,
    drawNumber,
    drawnAtLabel,
    winningNumbers,
    pool,
    payout,
    totalTickets,
    jackpotWinners,
  } = data;

  const isLarge = lotteryType === "6_49";
  const accent = isLarge ? PALETTE.gold : PALETTE.teal;
  const title = isLarge ? "大樂透 LOTTO 6/49" : "小樂透 LOTTO 3/20";

  const ballColors = [PALETTE.gold, PALETTE.red, PALETTE.teal, PALETTE.orange, PALETTE.gold, PALETTE.red];
  const balls = winningNumbers
    .map((n, i) => renderBall(n, ballColors[i % ballColors.length]))
    .join("");

  const rows = [];
  if (isLarge) {
    rows.push(buildPrizeRow("頭獎(中 6)", payout.jackpot.winnerCount, payout.jackpot.perWinner, PALETTE.gold));
    rows.push(buildPrizeRow("二獎(中 5)", payout.second.winnerCount, payout.second.perWinner, PALETTE.red));
    rows.push(buildPrizeRow("三獎(中 4)", payout.third?.winnerCount || 0, payout.third?.perWinner || 0, PALETTE.teal));
    rows.push(buildPrizeRow("四獎(中 3)", payout.fourth?.winnerCount || 0, payout.fourth?.perWinner || 0, PALETTE.muted));
  } else {
    rows.push(buildPrizeRow("頭獎(中 3)", payout.jackpot.winnerCount, payout.jackpot.perWinner, PALETTE.gold));
    rows.push(buildPrizeRow("二獎(中 2)", payout.second.winnerCount, payout.second.perWinner, PALETTE.teal));
  }

  const rolledOver = payout.rolledOver?.amount || 0;
  const winnersText = formatWinnersLine(jackpotWinners);
  const winnersBlock = winnersText
    ? `
        <div style="display:flex;width:100%;margin-top:12px;align-items:center;padding:8px 12px;background:${PALETTE.reelBg};border:2px solid ${PALETTE.gold};box-sizing:border-box;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:18px;color:${PALETTE.gold};letter-spacing:2px;line-height:1;padding-right:10px;">🏆 頭獎得主</div>
          <div style="display:flex;flex:1;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.ink};line-height:1.2;padding-right:4px;overflow:hidden;">${winnersText}</div>
        </div>
      `
    : "";

  return `
    <div style="display:flex;width:1080px;height:780px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${PALETTE.card};border:3px solid ${PALETTE.ink};padding:32px 44px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:64px;height:64px;background:${accent};border:3px solid ${PALETTE.ink};align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${PALETTE.card};">透</div>
            <div style="display:flex;flex-direction:column;margin-left:20px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:36px;color:${PALETTE.ink};letter-spacing:4px;line-height:1;padding-right:6px;">${title}</div>
              <div style="display:flex;margin-top:6px;font-family:'SpaceMono';font-size:14px;color:${PALETTE.muted};letter-spacing:3px;line-height:1;padding-right:4px;">DRAW #${drawNumber} ・ ${drawId}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;padding:8px 18px;background:${PALETTE.ink};font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${PALETTE.card};letter-spacing:3px;padding-right:21px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:18px;border-top:2px dashed ${PALETTE.muted};"></div>

        <div style="display:flex;flex-direction:column;align-items:center;width:100%;margin-top:18px;">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:6px;color:${PALETTE.muted};line-height:1;padding-right:6px;">WINNING NUMBERS</div>
          <div style="display:flex;margin-top:18px;align-items:center;">${balls}</div>
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;margin-top:24px;padding:14px 0;border-top:2px dashed ${PALETTE.muted};border-bottom:2px dashed ${PALETTE.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">POOL</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${pool.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">TICKETS</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${totalTickets.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">ROLLOVER</div>
            <div style="display:flex;margin-left:8px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${PALETTE.ink};line-height:1;padding-right:4px;">${rolledOver.toLocaleString()}</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;width:100%;margin-top:14px;">
          ${rows.join("")}
        </div>

        ${winnersBlock}

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:14px;border-top:2px dashed ${PALETTE.muted};">
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.muted};line-height:1;padding-right:5px;">DRAWN AT ${drawnAtLabel}</div>
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${PALETTE.ink};line-height:1;padding-right:5px;">@SHUSHU CASINO</div>
        </div>

      </div>
    </div>
  `;
}

function buildCacheKey(data) {
  return [
    data.drawId,
    data.winningNumbers?.join(",") || "",
    data.totalTickets ?? "",
    (data.jackpotWinners || []).join(","),
  ].join("|");
}

async function generateLotteryResultCard(data) {
  const cacheKey = buildCacheKey(data);
  const cached = cardCache.get(cacheKey);
  if (cached) return cached;

  const markup = buildMarkup(data);
  const buf = await renderCard({ markup, width: 1080, height: 780 });
  cardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateLotteryResultCard;
