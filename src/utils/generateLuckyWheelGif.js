const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const GIFEncoder = require('gif-encoder-2');

const FONT_DIR = path.join(__dirname, '../../fonts');
let fontsLoaded = false;

function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Black.otf'), { family: 'NotoSans', weight: '900' });
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Medium.otf'), { family: 'NotoSans', weight: '400' });
  fontsLoaded = true;
}

// ─── Canvas layout ───────────────────────────────────────────────────────────
// 輪盤本身就是主體：方形畫布、置中放大，不再放右側資訊面板（結果由 embed 呈現）。
const W = 720;
const H = 720;
// 內部繪圖用設計尺寸 W×H；輸出 GIF 縮到 RENDER_W×RENDER_H 讓編碼更快，Discord 客戶端自動放大。
const RENDER_SCALE = 0.75;
const RENDER_W = Math.round(W * RENDER_SCALE);
const RENDER_H = Math.round(H * RENDER_SCALE);

const CX = 360;
const CY = 340;
const R_SECTOR = 274; // colored wedges reach this radius
const R_RIM = 286;    // outer rim
const R_HUB = 50;     // center hub

// ─── Palette ─────────────────────────────────────────────────────────────────
// 暖色系賭場主題：奶油底 + 漸層加深做出立體感、金屬金邊框與輪圈。
const C = {
  bgCenter: '#FCF6E8',
  bgEdge: '#E4D4B2',
  ink: '#2A2420',
  muted: '#9C875E',
  gold: '#C9963A',
  goldBright: '#F2D479',
  goldDeep: '#9A6A22',
  white: '#FFFFFF',
  win: '#2D7A4A',
  loss: '#888888',
  red: '#C0392B',
  dim: '#9A8F82',
};

// 鮮明但協調的珠寶色系（在奶油底上以白字呈現都清楚）；大獎（×50+）金色、< 1 少賠暖灰。
const WEDGE_COLORS = [
  '#C0392B', '#2980B9', '#27AE60', '#8E44AD',
  '#E08A2F', '#16A085', '#3F51A8', '#C0398A',
];

function wedgeColor(seg, i) {
  const mult = Number(seg?.mult) || 0;
  if (mult >= 50) return C.goldBright;
  if (mult < 1) return C.dim; // < 1（少賠）：暖灰
  return WEDGE_COLORS[i % WEDGE_COLORS.length];
}

function wedgeLabel(seg) {
  const mult = Number(seg?.mult) || 0;
  if (mult === 0) return seg?.label || '槓龜';
  return `×${mult}`;
}

// ─── Math helpers ────────────────────────────────────────────────────────────
function easeOut4(t) { return 1 - Math.pow(1 - t, 4); }

// Final wheel rotation so the winning wedge CENTER sits under the top pointer.
//
// Wedges are drawn starting at angle -π/2 (top, the pointer position) and laid
// out clockwise. Wedge i spans [i·step, (i+1)·step) in local (pre-rotation)
// space, so its center sits at localCenter = (i + 0.5)·step measured clockwise
// from the top. To bring that center to the pointer (top), we must rotate the
// wheel backwards by localCenter, i.e. by (2π − localCenter), plus N full turns
// for drama.
function landingAngle(winningIndex, segmentCount, fullTurns = 5) {
  const step = (2 * Math.PI) / segmentCount;
  const localCenter = (winningIndex + 0.5) * step;
  return fullTurns * 2 * Math.PI + (2 * Math.PI - localCenter);
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

function drawWheel(ctx, segments, wheelAngle) {
  const N = segments.length;
  const step = (2 * Math.PI) / N;

  ctx.save();
  ctx.translate(CX, CY);

  // Outer rim — 金屬漸層 + 柔和落地陰影做出立體感
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

  // Rotating wedges
  ctx.save();
  ctx.rotate(wheelAngle);

  for (let i = 0; i < N; i++) {
    const seg = segments[i];
    const a0 = i * step - Math.PI / 2;
    const a1 = a0 + step;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R_SECTOR, a0, a1);
    ctx.closePath();
    ctx.fillStyle = wedgeColor(seg, i);
    ctx.fill();

    // Divider line
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * R_HUB, Math.sin(a0) * R_HUB);
    ctx.lineTo(Math.cos(a0) * R_SECTOR, Math.sin(a0) * R_SECTOR);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label — horizontal (always upright = readable) and large
    const midA = a0 + step / 2;
    const tr = R_SECTOR * 0.64;
    const lab = wedgeLabel(seg);
    ctx.save();
    ctx.translate(Math.cos(midA) * tr, Math.sin(midA) * tr);
    ctx.font = `900 ${lab.length >= 4 ? 18 : lab.length >= 3 ? 21 : 24}px NotoSans`;
    ctx.fillStyle = (Number(seg?.mult) || 0) >= 50 ? C.ink : C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lab, 0, 0);
    ctx.restore();
  }

  // Inner ring
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
  ctx.fillText('LUCKY', 0, 0);

  ctx.restore(); // un-rotate
  ctx.restore(); // un-translate
}

// Fixed pointer at the top, pointing down into the wheel.
function drawPointer(ctx) {
  const tipY = CY - R_SECTOR + 6;
  const baseY = CY - R_RIM - 18;
  ctx.beginPath();
  ctx.moveTo(CX, tipY);
  ctx.lineTo(CX - 16, baseY);
  ctx.lineTo(CX + 16, baseY);
  ctx.closePath();
  ctx.fillStyle = C.red;
  ctx.fill();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawInfoPanel(ctx, { phase, segments, winningIndex, bet, payout, mult, label, username, balance }) {
  const px = 532;
  const gx = px + 22;
  let ty = 38;

  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(px, 26);
  ctx.lineTo(px, H - 26);
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // Title / brand
  ctx.font = '900 21px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('幸運轉盤 / LUCKY WHEEL', gx, ty);
  ty += 32;

  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx, ty);
  ctx.lineTo(W - 28, ty);
  ctx.stroke();
  ty += 16;

  if (phase === 'result') {
    const win = payout > bet;
    const seg = segments[winningIndex] || {};
    const segText = `${label || wedgeLabel(seg)}`;

    // Result chip
    ctx.fillStyle = mult >= 50 ? C.goldBright : win ? C.win : C.loss;
    ctx.beginPath();
    ctx.roundRect(gx, ty, 220, 56, 8);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '900 26px NotoSans';
    ctx.fillStyle = mult >= 50 ? C.ink : C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`×${mult}`, gx + 110, ty + 28);
    ty += 72;

    ctx.font = '400 15px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`停在：${segText}`, gx, ty);
    ty += 30;

    const net = payout - bet;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : net.toLocaleString();
    ctx.font = '900 24px NotoSans';
    ctx.fillStyle = net >= 0 ? C.win : C.red;
    ctx.fillText(`${netStr} CR`, gx, ty);
    ty += 38;

    ctx.font = '400 14px NotoSans';
    ctx.fillStyle = C.muted;
    ctx.fillText(`派彩 ${payout.toLocaleString()} CR`, gx, ty);
    ty += 22;
  } else {
    ctx.font = '400 16px NotoSans';
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('轉動中 Spinning...', gx, ty);
    ty += 30;

    ctx.font = '400 14px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.fillText(`下注 ${bet.toLocaleString()} CR`, gx, ty);
  }

  // Footer
  const footY = H - 42;
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(gx, footY - 10);
  ctx.lineTo(W - 28, footY - 10);
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.textBaseline = 'middle';
  ctx.font = '400 12px NotoSans';
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText('BET', gx, footY);

  ctx.font = '900 16px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.fillText(bet.toLocaleString(), gx + 34, footY);

  if (phase === 'result' && typeof balance === 'number') {
    ctx.font = '400 12px NotoSans';
    ctx.fillStyle = C.muted;
    ctx.fillText('BAL', gx + 150, footY);
    ctx.font = '900 16px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.fillText(balance.toLocaleString(), gx + 182, footY);
  }

  // Brand footer (right) + handle
  ctx.font = '400 12px NotoSans';
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  ctx.fillText('逼逼賭場', W - 28, footY - 16);

  const handle = `@${(username || 'PLAYER').toUpperCase()}`;
  ctx.fillStyle = C.ink;
  ctx.fillText(handle, W - 28, footY);
}

// 底部品牌小字（取代右側面板，讓輪盤當主體）。
// 以輪盤底緣為基準往下排，確保與輪圈之間留有間距、不會黏在一起。
function drawBrand(ctx, name) {
  const wheelBottom = CY + R_RIM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 24px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.fillText(name, W / 2, wheelBottom + 40);
  ctx.font = '400 13px NotoSans';
  ctx.fillStyle = C.muted;
  ctx.fillText('逼逼賭場', W / 2, wheelBottom + 62);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object}  data
 * @param {Array}   data.segments      - config segments [{ mult, label, emoji }]
 * @param {number}  data.winningIndex  - index of landed segment
 * @param {number}  data.bet
 * @param {number}  data.payout
 * @param {number}  data.mult
 * @param {string}  data.label
 * @param {string}  data.username
 * @param {number}  data.balance
 * @returns {Promise<Buffer>} GIF binary
 */
async function generateLuckyWheelGif({ segments, winningIndex, bet, payout, mult, label, username, balance }) {
  ensureFonts();

  const list = Array.isArray(segments) && segments.length ? segments : [];
  const idx = Math.max(0, Math.min(winningIndex | 0, list.length - 1));

  const canvas = createCanvas(RENDER_W, RENDER_H);
  const ctx = canvas.getContext('2d');
  ctx.scale(RENDER_SCALE, RENDER_SCALE);

  // 大幅縮短轉動與停留幀數，並改用 octree 量化（比 neuquant 快很多，
  // 輪盤為平塗色塊、品質足夠），讓 GIF 產生時間明顯下降、指令回應更快。
  const SPIN_FRAMES = 20;
  const STILL_FRAMES = 4;
  const TOTAL_FRAMES = SPIN_FRAMES + STILL_FRAMES;

  // Yield the event loop periodically so queued Discord interactions aren't
  // starved while canvas work runs on the main thread (see roulette gif).
  const YIELD_EVERY = 4;

  const encoder = new GIFEncoder(RENDER_W, RENDER_H, 'octree', true, TOTAL_FRAMES);
  encoder.setDelay(50);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  const finalAngle = landingAngle(idx, list.length, 5);

  const shared = { segments: list, winningIndex: idx, bet, payout, mult, label, username, balance };

  let frameCount = 0;
  async function addFrame() {
    encoder.addFrame(ctx);
    frameCount++;
    if (frameCount % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ── Phase 1: spin, ease-out to the landing angle ──────────
  for (let f = 0; f < SPIN_FRAMES; f++) {
    const e = easeOut4((f + 1) / SPIN_FRAMES);
    clearFrame(ctx);
    drawWheel(ctx, list, e * finalAngle);
    drawPointer(ctx);
    drawBrand(ctx, '幸運轉盤');
    await addFrame();
  }

  // ── Phase 2: static result（幀數少，最後一幀停留久一點讓結果看清楚）──
  for (let f = 0; f < STILL_FRAMES; f++) {
    encoder.setDelay(f === STILL_FRAMES - 1 ? 1500 : 60);
    clearFrame(ctx);
    drawWheel(ctx, list, finalAngle);
    drawPointer(ctx);
    drawBrand(ctx, '幸運轉盤');
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generateLuckyWheelGif;
module.exports.landingAngle = landingAngle;
