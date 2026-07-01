// 賽馬比賽動畫 GIF。米色配色，與 generateHorseRaceResultCard 同調。
// 把 simulateRace 的 keyframes 線性插值成 30 幀平滑動畫，再加 4 幀定格收尾。
// 尺寸刻意壓在 Discord 8 MB 上限內：640×400, 34 frames, octree quality 20。

const path = require("path");
const { createCanvas, registerFont } = require("canvas");
const GIFEncoder = require("gif-encoder-2");

const { HORSES, TRACK_LENGTH } = require("../features/casino/horseRacing/engine");

const FONT_DIR = path.join(__dirname, "../../fonts");
let fontsLoaded = false;
function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, "NotoSansJP-Black.otf"), {
    family: "NotoSans",
    weight: "900",
  });
  registerFont(path.join(FONT_DIR, "NotoSansJP-Medium.otf"), {
    family: "NotoSans",
    weight: "500",
  });
  fontsLoaded = true;
}

const W = 640;
const H = 400;

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
};

// 每匹馬一個固定色，方便玩家在動畫中分辨。
const HORSE_COLORS = {
  1: PALETTE.gold,
  2: PALETTE.ink,
  3: PALETTE.bronze,
  4: PALETTE.silver,
  5: PALETTE.red,
  6: PALETTE.teal,
};

const LANE_TOP = 86;
const LANE_HEIGHT = 43;
const LANE_LABEL_X = 24;
const TRACK_X0 = 125;
const TRACK_X1 = W - 30;
const TRACK_W = TRACK_X1 - TRACK_X0;
const HORSE_RADIUS = 13;

function drawBackground(ctx) {
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, W - 20, H - 20);
}

function drawHeader(ctx, { gameId, pool, betsCount }) {
  // 金色「馬」字 logo，呼應結果卡
  ctx.fillStyle = PALETTE.gold;
  ctx.fillRect(22, 22, 38, 38);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 22, 38, 38);

  ctx.fillStyle = PALETTE.card;
  ctx.font = '900 24px NotoSans';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("馬", 41, 42);

  ctx.fillStyle = PALETTE.ink;
  ctx.font = '900 18px NotoSans';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("賽馬大賽 ・ 比賽進行中", 70, 24);

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '500 10px NotoSans';
  ctx.fillText(`RACE ${gameId}`, 70, 48);

  // 右上彩池資訊
  ctx.fillStyle = PALETTE.muted;
  ctx.font = '500 9px NotoSans';
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText("POOL", W - 96, 26);
  ctx.fillText("BETS", W - 30, 26);

  ctx.fillStyle = PALETTE.ink;
  ctx.font = '900 16px NotoSans';
  ctx.fillText(pool.toLocaleString(), W - 96, 40);
  ctx.fillText(String(betsCount), W - 30, 40);

  // 標題分隔虛線
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = PALETTE.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(22, 74);
  ctx.lineTo(W - 22, 74);
  ctx.stroke();
  ctx.restore();
}

function drawFinishLine(ctx, x, top, height) {
  // 黑白格旗：每格 4px 高
  const cell = 4;
  const w = 10;
  const rows = Math.floor(height / cell);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 2; c++) {
      const isInk = (r + c) % 2 === 0;
      ctx.fillStyle = isInk ? PALETTE.ink : PALETTE.card;
      ctx.fillRect(x + c * (w / 2), top + r * cell, w / 2, cell);
    }
  }
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, top, w, rows * cell);
}

function drawLane(ctx, idx, horse, position, trackLength, isLeader) {
  const top = LANE_TOP + idx * LANE_HEIGHT;
  const cy = top + LANE_HEIGHT / 2;
  const railTop = cy - 11;
  const railH = 22;

  // 跑道底色
  ctx.fillStyle = PALETTE.rail;
  ctx.fillRect(TRACK_X0, railTop, TRACK_W, railH);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(TRACK_X0, railTop, TRACK_W, railH);

  // 跑道中線
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.strokeStyle = PALETTE.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(TRACK_X0 + 5, cy);
  ctx.lineTo(TRACK_X1 - 14, cy);
  ctx.stroke();
  ctx.restore();

  // 終點旗
  drawFinishLine(ctx, TRACK_X1 - 10, railTop + 1, railH - 2);

  // 左側馬號徽章
  const color = HORSE_COLORS[horse.id] || PALETTE.ink;
  ctx.fillStyle = color;
  ctx.fillRect(LANE_LABEL_X, cy - 11, 22, 22);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(LANE_LABEL_X, cy - 11, 22, 22);
  ctx.fillStyle = PALETTE.card;
  ctx.font = '900 13px NotoSans';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(horse.id), LANE_LABEL_X + 11, cy + 1);

  // 馬名
  ctx.fillStyle = PALETTE.ink;
  ctx.font = '900 13px NotoSans';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(horse.name, LANE_LABEL_X + 30, cy - 4);

  // 賠率
  ctx.fillStyle = PALETTE.muted;
  ctx.font = '500 9px NotoSans';
  ctx.fillText(`×${horse.payout.toFixed(1)}`, LANE_LABEL_X + 30, cy + 9);

  // 馬匹本體：圓形徽章沿跑道滑動
  const ratio = Math.max(0, Math.min(1, position / trackLength));
  const travelStart = TRACK_X0 + HORSE_RADIUS + 2;
  const travelEnd = TRACK_X1 - HORSE_RADIUS - 12;
  const hx = travelStart + (travelEnd - travelStart) * ratio;

  // 陰影
  ctx.beginPath();
  ctx.arc(hx + 1.5, cy + 1.5, HORSE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.20)";
  ctx.fill();

  // 主體
  ctx.beginPath();
  ctx.arc(hx, cy, HORSE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = isLeader ? 2.5 : 1.5;
  ctx.stroke();

  // 領先者外框再加一圈金光暈
  if (isLeader) {
    ctx.beginPath();
    ctx.arc(hx, cy, HORSE_RADIUS + 3, 0, Math.PI * 2);
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  ctx.fillStyle = PALETTE.card;
  ctx.font = '900 12px NotoSans';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(horse.id), hx, cy + 1);
}

function drawFooter(ctx) {
  const y = H - 22;
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(22, y - 10);
  ctx.lineTo(W - 22, y - 10);
  ctx.strokeStyle = PALETTE.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = PALETTE.muted;
  ctx.font = '500 10px NotoSans';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("看誰先衝過終點線…", 22, y);

  ctx.fillStyle = PALETTE.ink;
  ctx.font = '500 10px NotoSans';
  ctx.textAlign = "right";
  ctx.fillText("@SHUSHU CASINO", W - 22, y);
}

// 把 keyframes（每個是 6 個位置）等距內插成 totalFrames 幀。
function interpolateFrames(keyframes, totalFrames) {
  if (keyframes.length === 0) return [];
  if (keyframes.length === 1 || totalFrames <= 1) {
    return Array.from({ length: totalFrames }, () => keyframes[0].slice());
  }
  const out = [];
  for (let i = 0; i < totalFrames; i++) {
    const t = i / (totalFrames - 1);
    const segPos = t * (keyframes.length - 1);
    const lo = Math.floor(segPos);
    const hi = Math.min(keyframes.length - 1, lo + 1);
    const frac = segPos - lo;
    const a = keyframes[lo];
    const b = keyframes[hi];
    out.push(a.map((v, idx) => v + (b[idx] - v) * frac));
  }
  return out;
}

// 以最終位置決定當前領先者（第一名）的索引。
function pickLeaderIdx(positions) {
  let best = -1;
  let bestVal = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i] > bestVal) {
      bestVal = positions[i];
      best = i;
    }
  }
  return best;
}

async function generateHorseRaceGif({
  gameId,
  frames,
  pool,
  betsCount,
  trackLength = TRACK_LENGTH,
}) {
  ensureFonts();

  const ANIM_FRAMES = 30;
  const HOLD_FRAMES = 4;
  const TOTAL_FRAMES = ANIM_FRAMES + HOLD_FRAMES;
  const FRAME_DELAY_MS = 120;

  const interpolated = interpolateFrames(frames || [], ANIM_FRAMES);
  const last = interpolated[interpolated.length - 1] || HORSES.map(() => 0);
  for (let i = 0; i < HOLD_FRAMES; i++) interpolated.push(last.slice());

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // octree 量化比 neuquant 快很多（賽道為平塗色塊，品質足夠），縮短 GIF 產生時間。
  const encoder = new GIFEncoder(W, H, "octree", true, TOTAL_FRAMES);
  encoder.setDelay(FRAME_DELAY_MS);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  // 每 4 幀讓出一次 event loop，避免阻塞 Discord 互動 token。
  const YIELD_EVERY = 4;
  for (let f = 0; f < interpolated.length; f++) {
    const positions = interpolated[f];
    const leaderIdx = pickLeaderIdx(positions);

    drawBackground(ctx);
    drawHeader(ctx, { gameId, pool, betsCount });
    for (let i = 0; i < HORSES.length; i++) {
      drawLane(ctx, i, HORSES[i], positions[i], trackLength, i === leaderIdx);
    }
    drawFooter(ctx);

    encoder.addFrame(ctx);
    if ((f + 1) % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  encoder.finish();
  return {
    buffer: encoder.out.getData(),
    durationMs: TOTAL_FRAMES * FRAME_DELAY_MS,
  };
}

module.exports = generateHorseRaceGif;
