// 彈珠台（Plinko）結果圖：用 satori（HTML/CSS flex）+ 內嵌 SVG 畫板面。
//   - 釘板與落球路徑用一張絕對定位的 SVG 畫（circle 釘、path 路徑、circle 球）。
//   - 底部落點格倍率用 HTML flex 排版（satori 對文字最穩），命中格高亮。
// 與 generateCrashCard 同套渲染管線（renderCard → worker → resvg → PNG）。

const { renderCard } = require("./cardRenderer");

const PAL_WIN = {
  bg: "#0B1F1A",
  panel: "#10362C",
  ink: "#F4ECD8",
  muted: "#86B8A6",
  accent: "#FFD84D",
  ball: "#FFD84D",
  path: "#FFD84D",
  peg: "#5C7A6E",
};
const PAL_LOSE = {
  bg: "#1A0F12",
  panel: "#36181E",
  ink: "#F4ECD8",
  muted: "#D89AA4",
  accent: "#FF6E7A",
  ball: "#FF6E7A",
  path: "#FF8A66",
  peg: "#7A5A60",
};

// 落點倍率著色：高倍暖色、打平藍、賠錢灰。
function bucketColor(mult) {
  if (mult >= 5) return { bg: "#C9302C", fg: "#FFF4E0" };
  if (mult >= 2) return { bg: "#E08A2B", fg: "#1A1208" };
  if (mult >= 1) return { bg: "#3D6F6A", fg: "#F4ECD8" };
  return { bg: "#3A3A44", fg: "#B8B8C4" };
}

const CW = 78; // 每格 / 每欄寬
const SY = 54; // 每排垂直間距
const PEG_TOP = 26;
const PAD = 28; // 白框外的暗色留白
const INNER_PAD_X = 26; // 白框內左右留白
const BORDER = 3; // 白框線寬

// 第 j 層（0..R）、索引 p（0..j，= 目前往右次數）的釘 / 球座標。
// 設計成 x(R,p) 剛好對齊底部第 p 個落點格中心。
function nodeX(j, p, buckets) {
  return (CW / 2) * (buckets + 2 * p - j);
}
function nodeY(j) {
  return PEG_TOP + j * SY;
}

function buildBoardSvg(result, P) {
  const R = result.rows;
  const buckets = R + 1;
  const boardW = CW * buckets;
  const boardH = PEG_TOP + R * SY + 28;

  const parts = [];

  // 釘：第 1..R 層的格點（最頂的投球點不畫釘）。
  for (let j = 1; j <= R; j += 1) {
    for (let p = 0; p <= j; p += 1) {
      parts.push(
        `<circle cx="${nodeX(j, p, buckets).toFixed(1)}" cy="${nodeY(j)}" r="4.5" fill="${P.peg}"/>`
      );
    }
  }

  // 落球路徑：第 j 層的索引 = path 前 j 步往右的次數。
  let rights = 0;
  const pts = [[nodeX(0, 0, buckets), nodeY(0)]];
  for (let j = 0; j < R; j += 1) {
    if (result.path[j] === "R") rights += 1;
    pts.push([nodeX(j + 1, rights, buckets), nodeY(j + 1)]);
  }
  const d = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  parts.push(
    `<path d="${d}" fill="none" stroke="${P.path}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`
  );

  // 球：終點。
  const [bx, by] = pts[pts.length - 1];
  parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="13" fill="${P.ball}" stroke="${P.ink}" stroke-width="3"/>`);

  return `<svg width="${boardW}" height="${boardH}" viewBox="0 0 ${boardW} ${boardH}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;">${parts.join("")}</svg>`;
}

function bucketRow(result) {
  const cells = result.row
    .map((m, i) => {
      const c = bucketColor(m);
      const hit = i === result.bucket;
      const border = hit ? "border:4px solid #FFD84D;" : "border:3px solid rgba(0,0,0,0.25);";
      return `<div style="display:flex;width:${CW}px;height:54px;align-items:center;justify-content:center;background:${c.bg};${border}box-sizing:border-box;font-family:'SpaceMono';font-weight:700;font-size:${m >= 100 ? 17 : 20}px;color:${c.fg};">${m}x</div>`;
    })
    .join("");
  return `<div style="display:flex;flex-direction:row;width:${CW * result.row.length}px;">${cells}</div>`;
}

function buildMarkup(result, opts) {
  const { username, balance, cardW, cardH } = opts;
  const win = result.payout > result.bet;
  const P = win ? PAL_WIN : PAL_LOSE;
  const R = result.rows;
  const buckets = R + 1;
  const boardW = CW * buckets;
  const boardH = PEG_TOP + R * SY + 28;

  const headline = win
    ? `命中 ×${result.multiplier}`
    : result.payout === result.bet
      ? `打平 ×${result.multiplier}`
      : `命中 ×${result.multiplier}`;
  const headColor = win ? P.accent : P.muted;
  const net = result.payout - result.bet;
  const netStr = `${net > 0 ? "＋" : net < 0 ? "－" : "±"}${Math.abs(net).toLocaleString()}`;

  const board = buildBoardSvg(result, P);
  const buckets_html = bucketRow(result);

  return `
    <div style="display:flex;width:${cardW}px;height:${cardH}px;background:${P.bg};padding:${PAD}px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${P.bg};border:3px solid ${P.ink};padding:22px 26px;box-sizing:border-box;">

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:54px;height:54px;background:${P.accent};align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:700;font-size:20px;color:${P.bg};">PK</div>
            <div style="display:flex;margin-left:16px;font-family:'NotoSansTC';font-weight:900;font-size:34px;color:${P.ink};letter-spacing:6px;padding-right:6px;">彈 珠 台</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 14px;background:${P.ink};font-family:'NotoSansTC';font-weight:500;font-size:15px;color:${P.bg};letter-spacing:3px;padding-right:18px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:12px;border-top:2px dashed ${P.muted};"></div>

        <div style="display:flex;flex-direction:column;align-items:center;margin-top:18px;">
          <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:30px;color:${headColor};letter-spacing:4px;padding-right:4px;">${headline}</div>
          <div style="display:flex;position:relative;width:${boardW}px;height:${boardH}px;margin-top:14px;background:${P.panel};border:3px solid ${P.ink};box-sizing:border-box;">
            ${board}
          </div>
          <div style="display:flex;margin-top:10px;">${buckets_html}</div>
        </div>

        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:20px;padding-top:16px;border-top:2px dashed ${P.muted};">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:20px;color:${P.ink};letter-spacing:3px;padding-right:3px;">${username || "玩家"}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:24px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">下注</div>
              <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;">${result.bet.toLocaleString()}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;margin-right:24px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">淨輸贏</div>
              <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${headColor};margin-top:2px;">${netStr}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:14px;color:${P.muted};letter-spacing:2px;padding-right:2px;">餘額</div>
              <div style="display:flex;font-family:'SpaceMono';font-weight:700;font-size:22px;color:${P.ink};margin-top:2px;">${typeof balance === "number" ? balance.toLocaleString() : "—"}</div>
            </div>
          </div>
        </div>

      </div>
    </div>
  `;
}

async function generatePlinkoCard(result, opts = {}) {
  const R = result.rows;
  const boardW = CW * (R + 1);
  // 卡寬要含：白框外留白 + 白框線 + 白框內留白，板面才不會頂到白框。
  const cardW = boardW + (PAD + BORDER + INNER_PAD_X) * 2;
  const boardH = PEG_TOP + R * SY + 28;
  const cardH = boardH + 394; // 板面 + 頁首/頁尾固定高
  const markup = buildMarkup(result, { ...opts, cardW, cardH });
  return renderCard({ markup, width: cardW, height: cardH });
}

module.exports = generatePlinkoCard;
