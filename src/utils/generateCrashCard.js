const { renderCard } = require("./cardRenderer");

const PALETTE_WIN = {
  bg: "#0B1538",
  panel: "#13235A",
  ink: "#F4ECD8",
  muted: "#8FA2D8",
  accent: "#FFD84D",
  trail: "#FFD84D",
  flame: "#FF7A45",
  flameDeep: "#C9302C",
  glow: "rgba(255, 216, 77, 0.22)",
};

const PALETTE_LOSE = {
  bg: "#1A0B12",
  panel: "#3A1118",
  ink: "#F4ECD8",
  muted: "#D88F9E",
  accent: "#FF4D5E",
  trail: "#FF7A45",
  flame: "#FFD84D",
  flameDeep: "#C9302C",
  glow: "rgba(255, 77, 94, 0.22)",
};

function palette(state) {
  return state.result === "cashout" ? PALETTE_WIN : PALETTE_LOSE;
}

// 把 [0, 1] 的進度對應到火箭 y 座標（畫面上越上越接近頂端）。
function rocketY(progress, top = 110, bottom = 520) {
  const p = Math.max(0, Math.min(1, progress));
  return Math.round(bottom - (bottom - top) * p);
}

// 火箭 SVG：使用簡單幾何形狀拼出，避免依賴外部圖檔。
function rocketSvg(size = 120, dim = false) {
  const opacity = dim ? 0.55 : 1;
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity};">
      <!-- 火焰 -->
      <path d="M50 92 L60 116 L70 92 Z" fill="#FF7A45"/>
      <path d="M54 92 L60 106 L66 92 Z" fill="#FFD84D"/>
      <!-- 機身 -->
      <path d="M60 8 C44 28 36 50 36 70 L36 92 L84 92 L84 70 C84 50 76 28 60 8 Z" fill="#F4ECD8" stroke="#2A2420" stroke-width="3"/>
      <!-- 窗 -->
      <circle cx="60" cy="48" r="10" fill="#3D6F6A" stroke="#2A2420" stroke-width="3"/>
      <circle cx="60" cy="48" r="4" fill="#F4ECD8"/>
      <!-- 翼 -->
      <path d="M36 70 L20 92 L36 92 Z" fill="#C9302C" stroke="#2A2420" stroke-width="3"/>
      <path d="M84 70 L100 92 L84 92 Z" fill="#C9302C" stroke="#2A2420" stroke-width="3"/>
    </svg>
  `;
}

// 爆炸 SVG
function explosionSvg(size = 160) {
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
      <polygon points="100,8 122,72 192,72 134,110 158,178 100,138 42,178 66,110 8,72 78,72" fill="#FF7A45" stroke="#2A2420" stroke-width="4"/>
      <polygon points="100,40 116,82 162,82 124,108 140,152 100,124 60,152 76,108 38,82 84,82" fill="#FFD84D"/>
      <circle cx="100" cy="100" r="20" fill="#C9302C"/>
    </svg>
  `;
}

// 星空背景：固定點陣，每次同樣（穩定畫面，不亂跳）。
function starsLayer(width, height, count = 70) {
  const stars = [];
  // 用簡單 LCG 取 deterministic 偽亂數
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rnd() * width);
    const y = Math.floor(rnd() * height);
    const r = rnd() < 0.15 ? 2 : 1;
    const opacity = 0.4 + rnd() * 0.5;
    stars.push(
      `<circle cx="${x}" cy="${y}" r="${r}" fill="#FFFFFF" opacity="${opacity.toFixed(2)}"/>`,
    );
  }
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;">${stars.join("")}</svg>`;
}

function buildMarkup(data) {
  const { username, state, balance } = data;
  const P = palette(state);
  const handle = `@${(username || "shushu").toUpperCase()}`;

  const isWin = state.result === "cashout";
  const bust = state.bust;
  const target = state.autocashout;
  const cashoutAt = state.cashoutAt;

  // 火箭高度：根據「實際飛到哪」決定。
  //   贏：飛到 cashoutAt（玩家收手時的高度），相對 max(bust, cashoutAt) 比例
  //   輸：飛到 bust（最高就是 bust）
  //
  // 用 log 映射，避免高倍率被壓扁、低倍率沒高度。
  const reached = isWin ? cashoutAt : bust;
  const scaleMax = Math.max(2, bust, target ?? 0);
  const progress =
    Math.log(Math.max(1, reached)) / Math.log(Math.max(1.01, scaleMax));
  const ry = rocketY(progress, 96, 480);

  const stageW = 560;
  const stageH = 520;

  const headline = isWin ? "成功收手" : "火箭爆炸";
  const headlineColor = P.accent;

  const settleAmount = isWin ? state.payout : state.bet;
  const settleAmountPrefix = isWin ? "+" : "−";

  const targetLine =
    target != null
      ? `自動收手 ×${target.toFixed(2)}`
      : "手動收手．無自動";
  const bustLine = `本局爆炸 ×${bust.toFixed(2)}`;
  const cashoutLine = isWin
    ? `成功收手於 ×${cashoutAt.toFixed(2)}`
    : "沒搶到收手";

  return `
    <div style="display:flex;width:1080px;height:920px;background:${P.bg};padding:24px;box-sizing:border-box;font-family:'NotoSansTC';">
      <div style="display:flex;flex-direction:column;width:100%;height:100%;background:${P.bg};border:3px solid ${P.ink};padding:28px 40px;box-sizing:border-box;">

        <!-- header -->
        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;">
            <div style="display:flex;width:60px;height:60px;background:${P.accent};border:3px solid ${P.ink};box-sizing:border-box;align-items:center;justify-content:center;font-family:'SpaceMono';font-weight:400;font-size:22px;color:${P.bg};letter-spacing:-1px;">CR</div>
            <div style="display:flex;margin-left:18px;font-family:'NotoSansTC';font-weight:900;font-size:38px;color:${P.ink};letter-spacing:6px;padding-right:6px;">火 箭 升 空</div>
          </div>
          <div style="display:flex;align-items:center;padding:6px 16px;background:${P.ink};font-family:'NotoSansTC';font-weight:500;font-size:16px;color:${P.bg};letter-spacing:3px;padding-right:19px;">逼逼賭場</div>
        </div>

        <div style="display:flex;width:100%;height:0;margin-top:14px;border-top:2px dashed ${P.muted};"></div>

        <!-- main stage：火箭 + 倍率刻度 -->
        <div style="display:flex;flex-direction:row;width:100%;margin-top:24px;align-items:flex-start;justify-content:space-between;">

          <!-- 左：火箭場景 -->
          <div style="display:flex;position:relative;width:${stageW}px;height:${stageH}px;background:${P.panel};border:3px solid ${P.ink};overflow:hidden;">
            ${starsLayer(stageW, stageH)}

            <!-- 火箭軌跡（虛線） -->
            <svg width="${stageW}" height="${stageH}" viewBox="0 0 ${stageW} ${stageH}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;left:0;top:0;">
              <line x1="${stageW / 2}" y1="${stageH - 40}" x2="${stageW / 2}" y2="${ry + 60}" stroke="${P.trail}" stroke-width="4" stroke-dasharray="8 8" opacity="0.7"/>
            </svg>

            <!-- 地面 / 月球表面 -->
            <div style="display:flex;position:absolute;left:0;bottom:0;width:${stageW}px;height:40px;background:${P.ink};opacity:0.15;"></div>

            <!-- 火箭或爆炸 -->
            <div style="display:flex;position:absolute;left:${stageW / 2 - 60}px;top:${ry - 60}px;width:120px;height:120px;align-items:center;justify-content:center;">
              ${isWin ? rocketSvg(120, false) : explosionSvg(140)}
            </div>

            <!-- 當前倍率大字（疊在上半段）：贏顯示收手點，輸顯示爆炸點 -->
            <div style="display:flex;position:absolute;left:0;top:24px;width:${stageW}px;justify-content:center;">
              <div style="display:flex;align-items:flex-end;line-height:1;">
                <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:88px;color:${P.accent};line-height:1;padding-right:6px;">×${(isWin ? cashoutAt : bust).toFixed(2)}</div>
              </div>
            </div>
          </div>

          <!-- 右：資訊欄 -->
          <div style="display:flex;flex-direction:column;width:380px;height:${stageH}px;justify-content:space-between;">

            <div style="display:flex;flex-direction:column;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:44px;color:${headlineColor};letter-spacing:8px;line-height:1;padding-right:8px;">${headline}</div>
              <div style="display:flex;align-items:flex-end;margin-top:18px;">
                <div style="display:flex;font-family:'SpaceMono';font-size:22px;color:${P.muted};line-height:1;margin-right:8px;margin-bottom:6px;">${settleAmountPrefix}</div>
                <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:60px;color:${headlineColor};line-height:1;">${settleAmount.toLocaleString()}</div>
                <div style="display:flex;font-family:'SpaceMono';font-size:18px;color:${P.muted};line-height:1;margin-left:10px;margin-bottom:10px;letter-spacing:2px;">CREDITS</div>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;background:${P.panel};border:3px solid ${P.ink};padding:18px 22px;">
              <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:18px;color:${P.muted};letter-spacing:4px;line-height:1;padding-right:4px;">本局結算</div>

              <div style="display:flex;flex-direction:column;margin-top:16px;">
                <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${P.ink};line-height:1.4;letter-spacing:2px;padding-right:2px;">${bustLine}</div>
                <div style="display:flex;font-family:'NotoSansTC';font-weight:500;font-size:22px;color:${P.ink};line-height:1.4;letter-spacing:2px;margin-top:6px;padding-right:2px;">${targetLine}</div>
                <div style="display:flex;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${P.accent};line-height:1.4;letter-spacing:2px;margin-top:6px;padding-right:2px;">${cashoutLine}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- footer：基本資訊列 -->
        <div style="display:flex;width:100%;justify-content:space-between;align-items:center;margin-top:auto;padding-top:20px;border-top:2px dashed ${P.muted};">
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${P.muted};line-height:1;padding-right:5px;">BET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${P.ink};line-height:1;">${state.bet.toLocaleString()}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${P.muted};line-height:1;padding-right:5px;">TARGET</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${P.ink};line-height:1;">${target != null ? `×${target.toFixed(2)}` : "—"}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${P.muted};line-height:1;padding-right:5px;">BUST</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${P.ink};line-height:1;">×${bust.toFixed(2)}</div>
          </div>
          <div style="display:flex;align-items:flex-end;">
            <div style="display:flex;font-family:'SpaceMono';font-size:13px;letter-spacing:5px;color:${P.muted};line-height:1;padding-right:5px;">BAL</div>
            <div style="display:flex;margin-left:7px;font-family:'NotoSansTC';font-weight:900;font-size:22px;color:${P.ink};line-height:1;">${(balance ?? 0).toLocaleString()}</div>
          </div>
          <div style="display:flex;font-family:'SpaceMono';font-size:14px;letter-spacing:5px;color:${P.ink};padding-right:5px;">${handle}</div>
        </div>

      </div>
    </div>
  `;
}

async function generateCrashCard(data) {
  const markup = buildMarkup(data);
  return renderCard({ markup, width: 1080, height: 920 });
}

module.exports = generateCrashCard;
