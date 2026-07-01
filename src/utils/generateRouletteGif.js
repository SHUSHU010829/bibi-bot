const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const GIFEncoder = require('gif-encoder-2');

const { WHEEL_ORDER, RED_NUMS } = require('../features/casino/roulette/numbers');

const FONT_DIR = path.join(__dirname, '../../fonts');
let fontsLoaded = false;

function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Black.otf'),  { family: 'NotoSans', weight: '900' });
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Medium.otf'), { family: 'NotoSans', weight: '400' });
  fontsLoaded = true;
}

// ─── Canvas layout ───────────────────────────────────────────────────────────
// 比照倍率輪盤：方形畫布、輪盤置中放大當主體，底部只留品牌小字，不再放右側資訊面板
//（結果數字／輸贏改由 embed 卡片呈現）。
const W = 720;
const H = 720;

const CX = 360;
const CY = 320;
const R_SECTOR = 270; // colored sectors reach this radius
const R_RIM    = 284; // gold outer rim
const R_HUB    = 48;  // center hub
const R_TRACK  = 278; // ball spinning track (on the gold rim)
const R_POCKET = 214; // ball resting position (inside sectors)
const BALL_RAD = 11;

const N = 37;
const SLOT_ANG = (2 * Math.PI) / N;

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bgCenter: '#FCF6E8',
  bgEdge:   '#E4D4B2',
  ink:      '#2A2420',
  muted:    '#9C875E',
  gold:     '#C9963A',
  goldBright:'#F2D479',
  goldDeep: '#9A6A22',
  red:      '#B83030',
  black:    '#181818',
  green:    '#1D6B45',
  white:    '#FFFFFF',
};

function slotColor(n) {
  if (n === 0) return C.green;
  return RED_NUMS.has(n) ? C.red : C.black;
}

// ─── Math helpers ────────────────────────────────────────────────────────────
function easeOut3(t)   { return 1 - Math.pow(1 - t, 3); }
function easeInOut2(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function normalizeAngle(a) {
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function shortestDiff(from, to) {
  let d = normalizeAngle(to) - normalizeAngle(from);
  if (d >  Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ─── Frame drawing ───────────────────────────────────────────────────────────
function clearFrame(ctx) {
  const bg = ctx.createRadialGradient(CX, CY, 80, CX, CY, 520);
  bg.addColorStop(0, C.bgCenter);
  bg.addColorStop(1, C.bgEdge);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = C.goldDeep;
  ctx.lineWidth = 3;
  ctx.strokeRect(12, 12, W - 24, H - 24);
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 1;
  ctx.strokeRect(18, 18, W - 36, H - 36);
}

function drawWheel(ctx, wheelAngle) {
  ctx.save();
  ctx.translate(CX, CY);

  // Outer gold rim — 金屬漸層 + 柔和落地陰影
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 5;
  const rimGrad = ctx.createLinearGradient(0, -R_RIM, 0, R_RIM);
  rimGrad.addColorStop(0, C.goldBright);
  rimGrad.addColorStop(0.5, C.gold);
  rimGrad.addColorStop(1, C.goldDeep);
  ctx.beginPath();
  ctx.arc(0, 0, R_RIM, 0, Math.PI * 2);
  ctx.fillStyle = rimGrad;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(0, 0, R_RIM, 0, Math.PI * 2);
  ctx.strokeStyle = C.goldDeep;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Rotating content
  ctx.save();
  ctx.rotate(wheelAngle);

  for (let i = 0; i < N; i++) {
    const num = WHEEL_ORDER[i];
    const a0 = i * SLOT_ANG - Math.PI / 2;
    const a1 = a0 + SLOT_ANG;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R_SECTOR, a0, a1);
    ctx.closePath();
    ctx.fillStyle = slotColor(num);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * R_HUB,    Math.sin(a0) * R_HUB);
    ctx.lineTo(Math.cos(a0) * R_SECTOR, Math.sin(a0) * R_SECTOR);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1;
    ctx.stroke();

    const midA = a0 + SLOT_ANG / 2;
    const tr = R_SECTOR * 0.78;
    ctx.save();
    ctx.translate(Math.cos(midA) * tr, Math.sin(midA) * tr);
    ctx.rotate(midA + Math.PI / 2);
    ctx.font = '900 15px NotoSans';
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 0, 0);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(0, 0, R_SECTOR, 0, Math.PI * 2);
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hub — 立體深色 + 金邊
  const hubGrad = ctx.createRadialGradient(-14, -14, 4, 0, 0, R_HUB);
  hubGrad.addColorStop(0, '#4A4038');
  hubGrad.addColorStop(1, C.ink);
  ctx.beginPath();
  ctx.arc(0, 0, R_HUB, 0, Math.PI * 2);
  ctx.fillStyle = hubGrad;
  ctx.fill();
  ctx.strokeStyle = C.goldBright;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = '900 9px NotoSans';
  ctx.fillStyle = C.goldBright;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ROULETTE', 0, 0);

  ctx.restore(); // un-rotate
  ctx.restore(); // un-translate
}

function drawBall(ctx, ballAngle, ballR) {
  const bx = CX + Math.cos(ballAngle) * ballR;
  const by = CY + Math.sin(ballAngle) * ballR;

  ctx.beginPath();
  ctx.arc(bx + 2, by + 2, BALL_RAD, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(bx, by, BALL_RAD, 0, Math.PI * 2);
  ctx.fillStyle = C.white;
  ctx.fill();
  ctx.strokeStyle = '#BBBBBB';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(bx - 3.5, by - 3.5, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fill();
}

// 底部品牌小字（取代右側面板，讓輪盤當主體）。
function drawBrand(ctx) {
  const wheelBottom = CY + R_RIM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 24px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.fillText('輪盤', W / 2, wheelBottom + 40);
  ctx.font = '400 13px NotoSans';
  ctx.fillStyle = C.muted;
  ctx.fillText('逼逼賭場', W / 2, wheelBottom + 62);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object}  data
 * @param {number}  data.result  - 0–36（球最後停在哪個號碼）
 * @returns {Promise<Buffer>} GIF binary
 */
async function generateRouletteGif({ result }) {
  ensureFonts();

  const resultIdx = WHEEL_ORDER.indexOf(result);

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  const SPIN_FRAMES   = 24;
  const SETTLE_FRAMES = 6;
  const STILL_FRAMES  = 4;
  const TOTAL_FRAMES  = SPIN_FRAMES + SETTLE_FRAMES + STILL_FRAMES;

  const YIELD_EVERY = 4;

  // octree 量化：輪盤是平塗色塊，品質足夠且比 neuquant 快很多。
  const encoder = new GIFEncoder(W, H, 'octree', true, TOTAL_FRAMES);
  encoder.setDelay(50);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  const finalWheelAngle = 6 * 2 * Math.PI;
  const spinEndBallAngle = -8 * 2 * Math.PI;

  const resultSectorLocal = (resultIdx + 0.5) * SLOT_ANG - Math.PI / 2;
  const ballTargetAbs = resultSectorLocal + finalWheelAngle;

  const diff = shortestDiff(spinEndBallAngle, ballTargetAbs);
  const trueBallTarget = spinEndBallAngle + diff;

  let frameCount = 0;
  async function addFrame() {
    encoder.addFrame(ctx);
    frameCount++;
    if (frameCount % YIELD_EVERY === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  // ── Phase 1: Spinning ────────────────────────────────────
  for (let f = 0; f < SPIN_FRAMES; f++) {
    const e = easeOut3(f / SPIN_FRAMES);
    clearFrame(ctx);
    drawWheel(ctx, e * finalWheelAngle);
    drawBall(ctx, e * spinEndBallAngle, R_TRACK);
    drawBrand(ctx);
    await addFrame();
  }

  // ── Phase 2: Ball settles into pocket ───────────────────
  for (let f = 0; f < SETTLE_FRAMES; f++) {
    const e = easeInOut2(f / SETTLE_FRAMES);
    const ballAngle = spinEndBallAngle + diff * e;
    const ballR     = R_TRACK + (R_POCKET - R_TRACK) * e;
    clearFrame(ctx);
    drawWheel(ctx, finalWheelAngle);
    drawBall(ctx, ballAngle, ballR);
    drawBrand(ctx);
    await addFrame();
  }

  // ── Phase 3: Static result（最後一幀停留久一點，讓結果看清楚）──
  for (let f = 0; f < STILL_FRAMES; f++) {
    encoder.setDelay(f === STILL_FRAMES - 1 ? 2500 : 80);
    clearFrame(ctx);
    drawWheel(ctx, finalWheelAngle);
    drawBall(ctx, trueBallTarget, R_POCKET);
    drawBrand(ctx);
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generateRouletteGif;
