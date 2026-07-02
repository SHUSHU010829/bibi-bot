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

// 每種彩券的圖卡外觀與獎項列（key 對應 payout.prizes 的欄位）。
const CARD_META = {
  "6_49": {
    title: "大樂透 LOTTO 6/49",
    accent: PALETTE.gold,
    height: 780,
    prizeRows: [
      ["頭獎(中 6)", "jackpot", PALETTE.gold],
      ["二獎(中 5)", "second", PALETTE.red],
      ["三獎(中 4)", "third", PALETTE.teal],
      ["四獎(中 3)", "fourth", PALETTE.muted],
    ],
  },
  "3_20": {
    title: "小樂透 LOTTO 3/20",
    accent: PALETTE.teal,
    height: 780,
    prizeRows: [
      ["頭獎(中 3)", "jackpot", PALETTE.gold],
      ["二獎(中 2)", "second", PALETTE.teal],
    ],
  },
  "power_38_8": {
    title: "威力彩 POWER 6/38",
    accent: PALETTE.orange,
    height: 980,
    prizeRows: [
      ["頭獎(6+特)", "jackpot", PALETTE.gold],
      ["貳獎(中 6)", "second", PALETTE.red],
      ["參獎(5+特)", "third", PALETTE.teal],
      ["肆獎(中 5)", "fourth", PALETTE.orange],
      ["伍獎(4+特)", "fifth", PALETTE.gold],
      ["陸獎(中 4)", "sixth", PALETTE.red],
      ["柒獎(3+特)", "seventh", PALETTE.teal],
      ["捌獎(2+特)", "eighth", PALETTE.orange],
      ["玖獎(3 / 1+特)", "ninth", PALETTE.muted],
    ],
  },
};

function getCardMeta(lotteryType) {
  return CARD_META[lotteryType] || CARD_META["3_20"];
}

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
    specialNumber,
    pool,
    payout,
    totalTickets,
    jackpotWinners,
  } = data;

  const meta = getCardMeta(lotteryType);
  const { accent, title } = meta;

  const ballColors = [PALETTE.gold, PALETTE.red, PALETTE.teal, PALETTE.orange, PALETTE.gold, PALETTE.red];
  const balls = winningNumbers
    .map((n, i) => renderBall(n, ballColors[i % ballColors.length]))
    .join("");

  const specialBall =
    specialNumber != null
      ? `
        <div style="display:flex;height:78px;align-items:center;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${PALETTE.muted};line-height:1;margin:0 4px;padding-bottom:2px;">＋</div>
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="display:flex;margin-bottom:4px;font-family:'NotoSansTC';font-weight:900;font-size:12px;letter-spacing:3px;color:${PALETTE.muted};line-height:1;padding-right:3px;">第二區</div>
          ${renderBall(specialNumber, PALETTE.ink)}
        </div>`
      : "";

  const rows = meta.prizeRows.map(([label, key, color]) => {
    const p = payout[key] || {};
    return buildPrizeRow(label, p.winnerCount || 0, p.perWinner || 0, color);
  });

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
    <div style="display:flex;width:1080px;height:${meta.height}px;background:${PALETTE.card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
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
          <div style="display:flex;margin-top:18px;align-items:flex-end;">${balls}${specialBall}</div>
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
  const buf = await renderCard({ markup, width: 1080, height: getCardMeta(data.lotteryType).height });
  cardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateLotteryResultCard;
