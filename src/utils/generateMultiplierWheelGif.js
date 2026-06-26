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

const CX = 360;
const CY = 350;
const R_SECTOR = 290;
const R_RIM = 302;
const R_HUB = 50;

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

// 倍率→底色：×2 藍、×5 紫、×10 琥珀，0（沒中）暖灰。
const MULT_COLORS = {
  2: '#2980B9',
  5: '#8E44AD',
  10: '#E08A2F',
};

function wedgeColor(seg) {
  const mult = Number(seg?.mult) || 0;
  if (mult === 0) return C.dim;
  return MULT_COLORS[mult] || '#2980B9';
}

function wedgeLabel(seg) {
  const mult = Number(seg?.mult) || 0;
  if (mult === 0) return '0';
  return `×${mult}`;
}

// ─── Math helpers ────────────────────────────────────────────────────────────
function easeOut4(t) { return 1 - Math.pow(1 - t, 4); }

// Final wheel rotation so the winning wedge CENTER sits under the top pointer.
// Wedges are drawn starting at -π/2 (top, pointer) and laid clockwise. Wedge i
// centre is at (i + 0.5)·step clockwise from the top; rotate backwards by that
// amount plus N full turns for drama.
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

function drawWheel(ctx, segments, wheelAngle, choice) {
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
    const mult = Number(seg?.mult) || 0;
    const a0 = i * step - Math.PI / 2;
    const a1 = a0 + step;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R_SECTOR, a0, a1);
    ctx.closePath();
    ctx.fillStyle = wedgeColor(seg);
    ctx.fill();

    // 玩家押的倍率：整圈相符的扇形加亮邊框，讓玩家看見目標。
    if (mult > 0 && mult === choice) {
      ctx.strokeStyle = C.goldBright;
      ctx.lineWidth = 5;
      ctx.stroke();
    }

    // Divider line
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * R_HUB, Math.sin(a0) * R_HUB);
    ctx.lineTo(Math.cos(a0) * R_SECTOR, Math.sin(a0) * R_SECTOR);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Label — horizontal (upright) and large
    const midA = a0 + step / 2;
    const tr = R_SECTOR * 0.64;
    const lab = wedgeLabel(seg);
    ctx.save();
    ctx.translate(Math.cos(midA) * tr, Math.sin(midA) * tr);
    ctx.font = `900 ${lab.length >= 4 ? 18 : lab.length >= 3 ? 21 : 24}px NotoSans`;
    ctx.fillStyle = mult === 0 ? '#C8BEB0' : C.white;
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
  ctx.fillText('MULTI', 0, 0);

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

function drawInfoPanel(ctx, { phase, segments, winningIndex, bet, payout, choice, username, balance }) {
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
  ctx.fillText('倍率轉盤 / MULTIPLIER WHEEL', gx, ty);
  ty += 32;

  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx, ty);
  ctx.lineTo(W - 28, ty);
  ctx.stroke();
  ty += 16;

  // 押注（一律顯示，讓玩家看見自己押了哪個倍率）
  ctx.font = '400 15px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.fillText(`押注 ×${choice}`, gx, ty);
  ty += 28;

  if (phase === 'result') {
    const seg = segments[winningIndex] || {};
    const landedMult = Number(seg?.mult) || 0;
    const won = payout > 0;

    // Result chip
    ctx.fillStyle = won ? C.win : C.loss;
    ctx.beginPath();
    ctx.roundRect(gx, ty, 220, 56, 8);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '900 24px NotoSans';
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(won ? '中獎' : '槓龜', gx + 110, ty + 28);
    ty += 72;

    ctx.font = '400 15px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`停在 ${landedMult === 0 ? '0' : `×${landedMult}`}`, gx, ty);
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
// 往上收，避免壓到內框線（內框底邊在 y≈702）。
function drawBrand(ctx, name) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '900 24px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.fillText(name, W / 2, H - 46);
  ctx.font = '400 13px NotoSans';
  ctx.fillStyle = C.muted;
  ctx.fillText('逼逼賭場', W / 2, H - 26);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object}  data
 * @param {Array}   data.segments      - ordered ring [{ mult }]
 * @param {number}  data.winningIndex  - index of landed wedge
 * @param {number}  data.choice        - player's chosen multiplier (2/5/10)
 * @param {number}  data.bet
 * @param {number}  data.payout
 * @param {string}  data.username
 * @param {number}  data.balance
 * @returns {Promise<Buffer>} GIF binary
 */
async function generateMultiplierWheelGif({ segments, winningIndex, choice, bet, payout, username, balance }) {
  ensureFonts();

  const list = Array.isArray(segments) && segments.length ? segments : [];
  const idx = Math.max(0, Math.min(winningIndex | 0, list.length - 1));
  const pick = Number(choice) || 0;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const SPIN_FRAMES = 32;
  const STILL_FRAMES = 22;
  const TOTAL_FRAMES = SPIN_FRAMES + STILL_FRAMES;

  const YIELD_EVERY = 4;

  const encoder = new GIFEncoder(W, H, 'neuquant', true, TOTAL_FRAMES);
  encoder.setDelay(50);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  const finalAngle = landingAngle(idx, list.length, 5);

  const shared = { segments: list, winningIndex: idx, choice: pick, bet, payout, username, balance };

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
    drawWheel(ctx, list, e * finalAngle, pick);
    drawPointer(ctx);
    drawBrand(ctx, '倍率輪盤');
    await addFrame();
  }

  // ── Phase 2: static result ────────────────────────────────
  for (let f = 0; f < STILL_FRAMES; f++) {
    clearFrame(ctx);
    drawWheel(ctx, list, finalAngle, pick);
    drawPointer(ctx);
    drawBrand(ctx, '倍率輪盤');
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generateMultiplierWheelGif;
module.exports.landingAngle = landingAngle;
