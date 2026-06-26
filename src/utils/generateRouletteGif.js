const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const GIFEncoder = require('gif-encoder-2');

const { WHEEL_ORDER, RED_NUMS, BET_TYPES } = require('../features/casino/roulette/numbers');
const { totalWagered } = require('../features/casino/roulette/engine');

const FONT_DIR = path.join(__dirname, '../../fonts');
let fontsLoaded = false;

function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Black.otf'),  { family: 'NotoSans', weight: '900' });
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Medium.otf'), { family: 'NotoSans', weight: '400' });
  fontsLoaded = true;
}

// ─── Canvas layout ───────────────────────────────────────────────────────────
const W = 1080;
const H = 760;

// Wheel geometry (center on left half)
const CX = 265;       // wheel center x
const CY = 380;       // wheel center y
const R_SECTOR = 215; // colored sectors reach this radius
const R_RIM    = 226; // gold outer rim
const R_HUB    = 44;  // center hub
const R_TRACK  = 222; // ball spinning track (on the gold rim)
const R_POCKET = 165; // ball resting position (inside sectors)
const BALL_RAD = 9;

const N = 37;
const SLOT_ANG = (2 * Math.PI) / N;

// ─── Palette ─────────────────────────────────────────────────────────────────
const C = {
  bg:    '#F4ECD8',
  ink:   '#2A2420',
  muted: '#A89270',
  gold:  '#C9963A',
  red:   '#B83030',
  black: '#181818',
  green: '#1D6B45',
  white: '#FFFFFF',
  win:   '#2D7A4A',
  loss:  '#888888',
};

function slotColor(n) {
  if (n === 0) return C.green;
  return RED_NUMS.has(n) ? C.red : C.black;
}

// ─── Math helpers ────────────────────────────────────────────────────────────
function easeOut3(t)    { return 1 - Math.pow(1 - t, 3); }
function easeInOut2(t)  { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

function normalizeAngle(a) {
  return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

// Shortest angular difference from `from` to `to` (result in -π..π)
function shortestDiff(from, to) {
  let d = normalizeAngle(to) - normalizeAngle(from);
  if (d >  Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ─── Frame drawing ───────────────────────────────────────────────────────────
function clearFrame(ctx) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Double border frame (matches other casino cards)
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(12, 12, W - 24, H - 24);
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.strokeRect(18, 18, W - 36, H - 36);
}

function drawWheel(ctx, wheelAngle) {
  ctx.save();
  ctx.translate(CX, CY);

  // Outer gold rim
  ctx.beginPath();
  ctx.arc(0, 0, R_RIM, 0, Math.PI * 2);
  ctx.fillStyle = C.gold;
  ctx.fill();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Rotating content
  ctx.save();
  ctx.rotate(wheelAngle);

  for (let i = 0; i < N; i++) {
    const num = WHEEL_ORDER[i];
    const a0 = i * SLOT_ANG - Math.PI / 2;
    const a1 = a0 + SLOT_ANG;

    // Colored sector
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R_SECTOR, a0, a1);
    ctx.closePath();
    ctx.fillStyle = slotColor(num);
    ctx.fill();

    // Gold divider line
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * R_HUB,    Math.sin(a0) * R_HUB);
    ctx.lineTo(Math.cos(a0) * R_SECTOR, Math.sin(a0) * R_SECTOR);
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Number text, rotated to face outward
    const midA = a0 + SLOT_ANG / 2;
    const tr = R_SECTOR * 0.74;
    ctx.save();
    ctx.translate(Math.cos(midA) * tr, Math.sin(midA) * tr);
    ctx.rotate(midA + Math.PI / 2);
    ctx.font = '900 12px NotoSans';
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 0, 0);
    ctx.restore();
  }

  // Inner sector border ring
  ctx.beginPath();
  ctx.arc(0, 0, R_SECTOR, 0, Math.PI * 2);
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Hub circle
  ctx.beginPath();
  ctx.arc(0, 0, R_HUB, 0, Math.PI * 2);
  ctx.fillStyle = C.ink;
  ctx.fill();
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Hub label
  ctx.font = '900 9px NotoSans';
  ctx.fillStyle = C.gold;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ROULETTE', 0, 0);

  ctx.restore(); // un-rotate
  ctx.restore(); // un-translate
}

function drawBall(ctx, ballAngle, ballR) {
  const bx = CX + Math.cos(ballAngle) * ballR;
  const by = CY + Math.sin(ballAngle) * ballR;

  // Drop shadow
  ctx.beginPath();
  ctx.arc(bx + 2, by + 2, BALL_RAD, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();

  // Ball body
  ctx.beginPath();
  ctx.arc(bx, by, BALL_RAD, 0, Math.PI * 2);
  ctx.fillStyle = C.white;
  ctx.fill();
  ctx.strokeStyle = '#BBBBBB';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Specular highlight
  ctx.beginPath();
  ctx.arc(bx - 3, by - 3, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fill();
}

function drawInfoPanel(ctx, { phase, bets, settlement, result, username, totalBudget, balanceAfter }) {
  const px = 532; // divider x
  const gx = px + 22;
  let ty = 38;

  // Dashed left divider
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(px, 26);
  ctx.lineTo(px, H - 26);
  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // ── Title ────────────────────────────────────────────────
  ctx.font = '900 21px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('EUROPEAN ROULETTE', gx, ty);
  ty += 32;

  ctx.strokeStyle = C.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(gx, ty);
  ctx.lineTo(W - 28, ty);
  ctx.stroke();
  ty += 14;

  // ── Result or Spinning ───────────────────────────────────
  if (phase === 'result' && settlement) {
    const rColor = slotColor(result);
    const colorLabel = result === 0 ? 'GREEN' : RED_NUMS.has(result) ? 'RED' : 'BLACK';

    // Result color block + number
    ctx.fillStyle = rColor;
    ctx.beginPath();
    ctx.roundRect(gx, ty, 74, 74, 8);
    ctx.fill();
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '900 38px NotoSans';
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(result), gx + 37, ty + 37);

    ctx.font = '900 16px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(colorLabel, gx + 86, ty + 37);
    ty += 88;

    // Net profit / loss line
    const wagered = totalWagered(bets);
    const net = settlement.totalWin - wagered;
    const netStr = net >= 0 ? `+${net.toLocaleString()}` : net.toLocaleString();
    ctx.font = '900 24px NotoSans';
    ctx.fillStyle = net >= 0 ? C.win : '#B83030';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${netStr} CR`, gx, ty);
    ty += 36;

    ctx.strokeStyle = C.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(gx, ty);
    ctx.lineTo(W - 28, ty);
    ctx.stroke();
    ty += 12;

    // Bet result rows
    ctx.font = '400 13px NotoSans';
    for (const br of settlement.betResults) {
      if (ty > H - 88) break;
      const def = BET_TYPES[br.type];
      const label = def?.label ?? br.type;
      const rightStr = br.won
        ? `+${br.winAmount.toLocaleString()}`
        : `-${br.amount.toLocaleString()}`;

      if (br.won) {
        ctx.fillStyle = 'rgba(45,122,74,0.09)';
        ctx.fillRect(gx - 4, ty - 1, W - gx - 24, 21);
      }
      ctx.fillStyle = br.won ? C.win : C.loss;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText((br.won ? '+ ' : '- ') + label, gx, ty);
      ctx.textAlign = 'right';
      ctx.fillText(rightStr, W - 28, ty);
      ty += 22;
    }

  } else {
    // Spinning phase: bet summary
    ctx.font = '400 15px NotoSans';
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Spinning...', gx, ty);
    ty += 28;

    for (const b of bets) {
      if (ty > H - 88) break;
      const def = BET_TYPES[b.type];
      const label = def?.label ?? b.type;
      ctx.font = '400 13px NotoSans';
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.fillText(label, gx, ty);
      ctx.textAlign = 'right';
      ctx.fillText(`${b.amount.toLocaleString()}  x${def?.payout ?? '?'}`, W - 28, ty);
      ty += 21;
    }
  }

  // ── Footer ────────────────────────────────────────────────
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
  ctx.fillText(totalBudget.toLocaleString(), gx + 34, footY);

  if (phase === 'result') {
    ctx.font = '400 12px NotoSans';
    ctx.fillStyle = C.muted;
    ctx.fillText('BAL', gx + 140, footY);

    ctx.font = '900 16px NotoSans';
    ctx.fillStyle = C.ink;
    ctx.fillText(balanceAfter.toLocaleString(), gx + 172, footY);
  }

  const handle = `@${(username || 'SHUSHU').toUpperCase()}`;
  ctx.font = '400 12px NotoSans';
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'right';
  ctx.fillText(handle, W - 28, footY);
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object}  data
 * @param {number}  data.result        - 0–36
 * @param {Array}   data.bets          - [{ type, amount, numbers }]
 * @param {object}  data.settlement    - output of settle()
 * @param {string}  data.username
 * @param {number}  data.totalBudget
 * @param {number}  data.balanceAfter
 * @returns {Promise<Buffer>} GIF binary
 */
async function generateRouletteGif({ result, bets, settlement, username, totalBudget, balanceAfter }) {
  ensureFonts();

  const resultIdx = WHEEL_ORDER.indexOf(result);

  const canvas  = createCanvas(W, H);
  const ctx     = canvas.getContext('2d');

  const SPIN_FRAMES   = 30;
  const SETTLE_FRAMES = 5;
  const STILL_FRAMES  = 5;
  const TOTAL_FRAMES  = SPIN_FRAMES + SETTLE_FRAMES + STILL_FRAMES;

  // Yield event loop every N frames so queued Discord interactions
  // (button clicks, etc.) can be processed before their 3-second token
  // window expires. Without this, canvas CPU work blocks the event loop
  // for ~7s, causing "Unknown interaction" (10062) errors.
  const YIELD_EVERY = 4;

  const encoder = new GIFEncoder(W, H, 'neuquant', true, TOTAL_FRAMES);
  encoder.setDelay(50);   // 20 fps
  encoder.setRepeat(0);   // play once, then stop
  encoder.setQuality(20); // 1=best, 20=faster encode
  encoder.start();

  // Wheel spins 6 full rotations clockwise; ball 8 rotations counterclockwise
  const finalWheelAngle = 6 * 2 * Math.PI;
  const spinEndBallAngle = -8 * 2 * Math.PI;

  // Target ball angle: center of the result slot in absolute canvas space
  const resultSectorLocal = (resultIdx + 0.5) * SLOT_ANG - Math.PI / 2;
  const ballTargetAbs = resultSectorLocal + finalWheelAngle;

  // Shortest path from spin-end to target (at most half a rotation)
  const diff = shortestDiff(spinEndBallAngle, ballTargetAbs);
  const trueBallTarget = spinEndBallAngle + diff;

  const shared = { bets, settlement, result, username, totalBudget, balanceAfter };

  // Add a frame and yield the event loop every YIELD_EVERY frames
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
    drawInfoPanel(ctx, { phase: 'spinning', ...shared });
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
    drawInfoPanel(ctx, { phase: 'spinning', ...shared });
    await addFrame();
  }

  // ── Phase 3: Static result display ──────────────────────
  for (let f = 0; f < STILL_FRAMES; f++) {
    clearFrame(ctx);
    drawWheel(ctx, finalWheelAngle);
    drawBall(ctx, trueBallTarget, R_POCKET);
    drawInfoPanel(ctx, { phase: 'result', ...shared });
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generateRouletteGif;
