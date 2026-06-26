const LruCache = require("./lruCache");
const { renderCard } = require("./cardRenderer");
const { SYMBOL_BY_KEY } = require("../features/casino/fishPrawnCrab/engine");

const fpcCardCache = new LruCache(64);

// 每種符號一個明確背景色 + 大字（單字），emoji 只當小點綴。
// 注意：cardRenderer 的彩色 emoji 支援不穩，視覺主體一律靠中文大字 + 底色，
// emoji 漏渲染也不影響辨識。
const SYMBOL_STYLE = {
  fish: { char: "魚", bg: "#2E6F8E", fg: "#FFFFFF", emoji: "🐟" },
  prawn: { char: "蝦", bg: "#C0563B", fg: "#FFFFFF", emoji: "🦐" },
  crab: { char: "蟹", bg: "#B5403A", fg: "#FFFFFF", emoji: "🦀" },
  gourd: { char: "葫", bg: "#4F8A4A", fg: "#FFFFFF", emoji: "🍐" },
  coin: { char: "錢", bg: "#C99A2E", fg: "#2A2420", emoji: "💰" },
  rooster: { char: "雞", bg: "#9A6FB0", fg: "#FFFFFF", emoji: "🐓" },
};

function symbolStyle(key) {
  return SYMBOL_STYLE[key] || { char: "?", bg: "#777", fg: "#FFF", emoji: "" };
}

function symbolName(key) {
  return SYMBOL_BY_KEY[key]?.name || key;
}

function renderTile(symbolKey, size, highlight, ink, gold) {
  const s = symbolStyle(symbolKey);
  const frameColor = highlight ? gold : ink;
  const frameWidth = highlight ? 6 : 3;
  const emojiSize = Math.round(size * 0.6);
  return `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;background:${s.bg};border:${frameWidth}px solid ${frameColor};border-radius:18px;box-sizing:border-box;margin:0 14px;">
      <div style="display:flex;font-family:'NotoSansTC';font-size:${emojiSize}px;line-height:1;">${s.emoji}</div>
    </div>
  `;
}

function buildMarkup(data) {
  const {
    username,
    roll,
    results = [],
    totalPayout = 0,
    betAmount = 0,
    net = 0,
    balance = 0,
  } = data;

  const card = "#F4ECD8";
  const ink = "#2A2420";
  const muted = "#A89270";
  const teal = "#3D6F6A";
  const gold = "#D4A437";

  const won = totalPayout > 0;
  const accent = won ? teal : muted;

  // 中獎的符號 key 集合 → 對應骰子加金框。
  const winningSymbols = new Set(
    results.filter((r) => r.won).map((r) => r.bet.symbol)
  );

  const handle = `@${(username || "shushu").toUpperCase()}`;

  const tiles = roll
    .map((key) => renderTile(key, 200, winningSymbols.has(key), ink, gold))
    .join("");

  // 每注一行：符號名 + 中 X 顆 → 倍率/派彩 或 沒中。保持精簡，骰子才是主角。
  const betRows = results
    .map((r) => {
      const name = symbolName(r.bet.symbol);
      const bg = r.won ? teal : muted;
      const detail = r.won
        ? `中 ${r.count} 顆  ${r.count}:1  +${r.payout.toLocaleString()}`
        : `沒中`;
      return `
        <div style="display:flex;align-items:center;width:100%;margin-top:10px;">
          <div style="display:flex;align-items:center;justify-content:center;width:96px;padding:6px 0;background:${bg};border:2px solid ${ink};box-sizing:border-box;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${card};">押 ${name}</div>
          <div style="display:flex;margin-left:16px;font-family:'NotoSansTC';font-weight:500;font-size:24px;color:${ink};letter-spacing:1px;">${detail}</div>
        </div>
      `;
    })
    .join("");

  const resultEmoji = won ? "✨" : "💸";
  const resultText = won
    ? `總派彩  +${totalPayout.toLocaleString()} CREDITS`
    : `沒中  下次再來`;

  return `
    <div style="display:flex;width:1080px;height:760px;background:${card};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${card};border:3px solid ${ink};padding:32px 44px;box-sizing:border-box;">

        <!-- Header：魚蝦蟹 標題 -->
        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:64px;height:64px;background:${accent};border:3px solid ${ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${card};">蟹</div>
            <div style="display:flex;flex-direction:column;margin-left:20px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:40px;color:${ink};letter-spacing:6px;padding-right:6px;">魚蝦蟹</div>
              <div style="display:flex;font-family:'SpaceMono';font-size:15px;letter-spacing:4px;color:${muted};padding-right:4px;">FISH-PRAWN-CRAB</div>
            </div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:5px;color:${ink};padding-right:5px;">${handle}</div>
        </div>

        <!-- 點點分隔線 -->
        <div style="display:flex;width:100%;height:0;margin-top:18px;border-top:2px dashed ${muted};"></div>

        <!-- 三顆骰子（主角） -->
        <div style="display:flex;width:100%;justify-content:center;align-items:center;margin-top:28px;">
          ${tiles}
        </div>

        <!-- 結果文字 -->
        <div style="display:flex;justify-content:center;align-items:center;width:100%;margin-top:22px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:30px;line-height:1;margin-right:16px;">${resultEmoji}</div>
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${accent};letter-spacing:5px;line-height:1;padding-right:5px;">${resultText}</div>
        </div>

        <!-- 每注明細 -->
        <div style="display:flex;flex-direction:column;width:100%;flex:1;margin-top:18px;">
          ${betRows}
        </div>

        <!-- 底部 BET / NET / BALANCE -->
        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:14px;border-top:2px dashed ${muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${ink};line-height:1;">${betAmount.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${muted};line-height:1;padding-right:5px;">NET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${net >= 0 ? teal : "#B5403A"};line-height:1;">${net >= 0 ? "+" : "-"}${Math.abs(net).toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${muted};line-height:1;padding-right:5px;">BALANCE</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:24px;color:${ink};line-height:1;">${balance.toLocaleString()}</div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:4px;color:${muted};padding-right:4px;">逼逼賭場</div>
        </div>

      </div>
    </div>
  `;
}

function buildCacheKey(data) {
  return [
    data.userId || "",
    data.roll?.join(",") || "",
    (data.results || [])
      .map((r) => `${r.bet.symbol}:${r.bet.amount}:${r.won ? 1 : 0}:${r.count}`)
      .join(";"),
    data.totalPayout ?? "",
    data.betAmount ?? "",
    data.net ?? "",
    data.balance ?? "",
  ].join("|");
}

async function generateFishPrawnCrabCard(data) {
  const cacheKey = buildCacheKey(data);
  const cached = fpcCardCache.get(cacheKey);
  if (cached) return cached;

  const markup = buildMarkup(data);
  const buf = await renderCard({ markup, width: 1080, height: 760 });
  fpcCardCache.set(cacheKey, buf);
  return buf;
}

module.exports = generateFishPrawnCrabCard;
module.exports.buildMarkup = buildMarkup;
