const path = require('path');
const axios = require('axios');
const { createCanvas, loadImage, registerFont } = require('canvas');
const GIFEncoder = require('gif-encoder-2');
const { Resvg } = require('@resvg/resvg-js');

const {
  SYMBOLS,
  SYMBOL_BY_ID,
  PAYLINES,
} = require('../features/casino/slot/paytable');

// ─── Fonts ───────────────────────────────────────────────────────────────────
const FONT_DIR = path.join(__dirname, '../../fonts');
let fontsLoaded = false;
function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Black.otf'),  { family: 'NotoSans', weight: '900' });
  registerFont(path.join(FONT_DIR, 'NotoSansJP-Medium.otf'), { family: 'NotoSans', weight: '500' });
  fontsLoaded = true;
}

// ─── Emoji rasterizer (twemoji SVG → PNG → canvas Image) ─────────────────────
const EMOJI_IMG_CACHE = new Map();
const TWEMOJI_VERSION = '14.0.2';
const EMOJI_RENDER_PX = 256;

function toCodePoint(emoji) {
  const codes = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f) continue;
    codes.push(cp.toString(16));
  }
  return codes.join('-');
}

async function getEmojiImage(emoji) {
  if (EMOJI_IMG_CACHE.has(emoji)) return EMOJI_IMG_CACHE.get(emoji);
  const code = toCodePoint(emoji);
  if (!code) return null;
  try {
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@${TWEMOJI_VERSION}/assets/svg/${code}.svg`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 5000 });
    const png = new Resvg(Buffer.from(res.data), {
      fitTo: { mode: 'width', value: EMOJI_RENDER_PX },
    }).render().asPng();
    const img = await loadImage(Buffer.from(png));
    EMOJI_IMG_CACHE.set(emoji, img);
    return img;
  } catch (_) {
    EMOJI_IMG_CACHE.set(emoji, null);
    return null;
  }
}

// ─── Canvas layout ───────────────────────────────────────────────────────────
const W = 1080;
const H = 870;
const CELL = 160;
const VIEW_ROWS = 3;
const VIEW_COLS = 3;
const REEL_GAP = 14;
const REELS_TOTAL_W = VIEW_COLS * CELL + (VIEW_COLS - 1) * REEL_GAP;
const REELS_TOTAL_H = VIEW_ROWS * CELL;
const STRIP_LEN = SYMBOLS.length;
const STRIP_H = STRIP_LEN * CELL;
const FOOTER_Y = 808;

const PALETTE = {
  card:   '#F4ECD8',
  ink:    '#2A2420',
  muted:  '#A89270',
  reelBg: '#E8DFC8',
  gold:   '#D4A437',
  red:    '#C9302C',
  teal:   '#3D6F6A',
  win:    '#2D7A4A',
  loss:   '#888888',
  gridDiv: '#C9BFA3',
};

function pickAccent(matchType) {
  switch (matchType) {
    case 'jackpot':       return PALETTE.gold;
    case 'triple':
    case 'double_cherry': return PALETTE.red;
    case 'double':        return PALETTE.teal;
    default:              return PALETTE.muted;
  }
}

function buildHeadline(matchType, winLineCount) {
  switch (matchType) {
    case 'jackpot':       return { left: '🎉', text: 'JACKPOT',  right: '🎉' };
    case 'triple':        return { left: '🎊', text: `三連線 ×${winLineCount || 1}`, right: null };
    case 'double_cherry': return { left: '🍒', text: `兩個櫻桃 ×${winLineCount || 1}`, right: null };
    case 'double':        return { left: '✨', text: `兩個一樣 ×${winLineCount || 1}`, right: null };
    default:              return { left: '💸', text: 'NO MATCH', right: null };
  }
}

// ─── Math helpers ────────────────────────────────────────────────────────────
function easeOut3(t) { return 1 - Math.pow(1 - t, 3); }
function clamp01(t)  { return Math.max(0, Math.min(1, t)); }
function mod(n, m)   { return ((n % m) + m) % m; }

// ─── Drawing primitives ──────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function dashedLine(ctx, x1, y1, x2, y2, color, dash = [5, 5]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

const EMOJI_FALLBACK = {
  '🍒': { bg: '#C9302C', label: 'CH' },
  '🍋': { bg: '#E0B53D', label: 'LM' },
  '🍉': { bg: '#3D8C5C', label: 'WM' },
  '🔔': { bg: '#D4A437', label: 'BL' },
  '⭐': { bg: '#E8B11C', label: 'ST' },
  '7️⃣': { bg: '#2A2420', label: '7' },
  '🎉': { bg: '#D4A437', label: '!' },
  '🎊': { bg: '#C9302C', label: '!' },
  '✨': { bg: '#3D6F6A', label: '*' },
  '💸': { bg: '#A89270', label: '$' },
  '💰': { bg: '#D4A437', label: '$' },
};

function drawEmoji(ctx, emoji, cx, cy, size) {
  const img = EMOJI_IMG_CACHE.get(emoji);
  if (img) {
    ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    return;
  }
  const fb = EMOJI_FALLBACK[emoji];
  if (!fb) return;
  ctx.save();
  ctx.fillStyle = fb.bg;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `900 ${Math.round(size * 0.45)}px NotoSans`;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fb.label, cx, cy + 1);
  ctx.restore();
}

// ─── Static frame chrome ─────────────────────────────────────────────────────
function drawBackground(ctx) {
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(0, 0, W, H);
}

function drawCardFrame(ctx) {
  const x = 24, y = 24, w = W - 48, h = H - 48;
  ctx.fillStyle = PALETTE.card;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
}

function drawHeader(ctx, accent) {
  const x = 71, y = 59;
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 64, 64);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 1.5, y + 1.5, 61, 61);

  // NotoSansJP 的 baseline='middle' 對 CJK 字偏上，視覺中心要再往下推一些
  ctx.font = '900 38px NotoSans';
  ctx.fillStyle = PALETTE.card;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('霸', x + 32, y + 46);

  ctx.font = '900 44px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('SLOT 3×3', x + 64 + 20, y + 34);

  const chipText = '逼逼賭場';
  ctx.font = '500 18px NotoSans';
  const chipW = ctx.measureText(chipText).width + 36;
  const chipH = 36;
  const chipX = W - 71 - chipW;
  const chipY = y + 32 - chipH / 2;
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(chipX, chipY, chipW, chipH);
  ctx.fillStyle = PALETTE.card;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(chipText, chipX + chipW / 2, chipY + chipH / 2 + 1);
}

function drawJackpotBanner(ctx, jackpotPool, jackpotBust, isBust) {
  const x = 71, y = 158, w = W - 71 * 2, h = 52;
  const bg = isBust ? PALETTE.gold : PALETTE.reelBg;

  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  drawEmoji(ctx, '💰', x + 24, y + h / 2, 26);
  ctx.font = '500 14px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const label = isBust ? 'JACKPOT BUSTED!' : 'JACKPOT POOL';
  let lx = x + 44;
  for (const ch of label) {
    ctx.fillText(ch, lx, y + h / 2 + 1);
    lx += ctx.measureText(ch).width + 5;
  }

  ctx.font = '900 30px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const amount = isBust
    ? `+${jackpotBust.toLocaleString()}`
    : jackpotPool.toLocaleString();
  ctx.fillText(amount, x + w - 18, y + h / 2 + 1);
}

function drawReelBox(ctx, rx, ry, offset, columnStrip, accent, highlightRows, pulse) {
  // viewport: CELL wide × VIEW_ROWS*CELL tall
  ctx.fillStyle = PALETTE.reelBg;
  ctx.fillRect(rx, ry, CELL, REELS_TOTAL_H);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rx, ry, CELL, REELS_TOTAL_H);
  ctx.clip();

  const off = mod(offset, STRIP_H);
  const baseI = Math.floor(off / CELL);
  for (let k = -1; k <= VIEW_ROWS; k++) {
    const i = mod(baseI + k, STRIP_LEN);
    const sym = columnStrip[i];
    const cy = ry + CELL / 2 + ((baseI + k) * CELL - off);
    drawEmoji(ctx, sym.emoji, rx + CELL / 2, cy, 110);
  }

  // Inner horizontal dividers between rows.
  ctx.strokeStyle = PALETTE.gridDiv;
  ctx.lineWidth = 1;
  for (let i = 1; i < VIEW_ROWS; i++) {
    const yy = ry + i * CELL;
    ctx.beginPath();
    ctx.moveTo(rx, yy);
    ctx.lineTo(rx + CELL, yy);
    ctx.stroke();
  }

  ctx.restore();

  // Outer frame
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(rx + 1.5, ry + 1.5, CELL - 3, REELS_TOTAL_H - 3);

  // Per-cell pulsing highlight on winning rows.
  if (highlightRows && highlightRows.size > 0) {
    const w = 4 + 2 * pulse;
    ctx.strokeStyle = accent;
    ctx.lineWidth = w;
    for (const row of highlightRows) {
      const cy = ry + row * CELL;
      ctx.strokeRect(rx + w / 2, cy + w / 2, CELL - w, CELL - w);
    }
  }
}

function measureHeadline(ctx, headline, size, weight = '900', gap = 12) {
  ctx.font = `${weight} ${size}px NotoSans`;
  const textW = ctx.measureText(headline.text).width + (size * 0.05) * (headline.text.length - 1);
  const emojiSize = Math.round(size * 1.05);
  const leftW = headline.left ? emojiSize + gap : 0;
  const rightW = headline.right ? emojiSize + gap : 0;
  return leftW + textW + rightW;
}

function drawHeadline(ctx, headline, color, cx, cy, size, weight, gap = 12) {
  ctx.textBaseline = 'middle';
  ctx.font = `${weight} ${size}px NotoSans`;
  const textW = ctx.measureText(headline.text).width + (size * 0.05) * (headline.text.length - 1);
  const emojiSize = Math.round(size * 1.05);
  const leftW = headline.left ? emojiSize + gap : 0;
  const rightW = headline.right ? emojiSize + gap : 0;
  const totalW = leftW + textW + rightW;

  let x = cx - totalW / 2;
  if (headline.left) {
    drawEmoji(ctx, headline.left, x + emojiSize / 2, cy, emojiSize);
    x += leftW;
  }

  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(headline.text, x, cy + 1);
  x += textW;

  if (headline.right) {
    drawEmoji(ctx, headline.right, x + gap + emojiSize / 2, cy, emojiSize);
  }
}

function drawResultPanel(ctx, opts) {
  const { phase, matchType, payout, accent, areaY, areaH, winLineCount } = opts;
  const cx = W / 2;

  if (phase === 'spinning') {
    ctx.font = '500 26px NotoSans';
    ctx.fillStyle = PALETTE.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = 'SPINNING...';
    const tw = ctx.measureText(label).width + 4 * (label.length - 1);
    let cursor = cx - tw / 2;
    for (const ch of label) {
      ctx.fillText(ch, cursor + ctx.measureText(ch).width / 2, areaY + areaH / 2);
      cursor += ctx.measureText(ch).width + 4;
    }
    return;
  }

  const headline = buildHeadline(matchType, winLineCount);
  if (payout > 0) {
    const headlineSize = 38;
    const payoutSize   = 58;
    const innerGap     = 24;
    const cy = areaY + areaH / 2;

    const headlineW = measureHeadline(ctx, headline, headlineSize, '900', 12);
    const numText = `＋${payout.toLocaleString()}`;
    ctx.font = `900 ${payoutSize}px NotoSans`;
    const payoutW = ctx.measureText(numText).width;

    const totalW = headlineW + innerGap + payoutW;
    const headlineCx = cx - totalW / 2 + headlineW / 2;
    const payoutCx   = cx + totalW / 2 - payoutW / 2;

    drawHeadline(ctx, headline, accent, headlineCx, cy, headlineSize, '900', 12);

    ctx.font = `900 ${payoutSize}px NotoSans`;
    ctx.fillStyle = accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(numText, payoutCx, cy);
  } else {
    drawHeadline(ctx, headline, PALETTE.muted, cx, areaY + areaH / 2, 42, '900', 16);
  }
}

function drawFooter(ctx, opts) {
  const { bet, balance, multiplier, won, username } = opts;
  const y = FOOTER_Y;

  dashedLine(ctx, 71, y - 26, W - 71, y - 26, PALETTE.muted, [3, 4]);

  ctx.textBaseline = 'middle';

  ctx.font = '500 13px NotoSans';
  ctx.fillStyle = PALETTE.muted;
  ctx.textAlign = 'left';
  let lx = 71;
  for (const ch of 'BET') {
    ctx.fillText(ch, lx, y);
    lx += ctx.measureText(ch).width + 5;
  }

  ctx.font = '900 24px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  const betText = bet.toLocaleString();
  ctx.fillText(betText, 71 + 38, y);

  if (won) {
    const betW = ctx.measureText(betText).width;
    ctx.font = '500 13px NotoSans';
    ctx.fillStyle = PALETTE.muted;
    let mx = 71 + 38 + betW + 14;
    for (const ch of `×${multiplier}`) {
      ctx.fillText(ch, mx, y);
      mx += ctx.measureText(ch).width + 3;
    }
  }

  ctx.font = '500 13px NotoSans';
  ctx.fillStyle = PALETTE.muted;
  const balLabel = 'BALANCE';
  ctx.font = '900 24px NotoSans';
  const balValueText = balance.toLocaleString();
  const balValueW = ctx.measureText(balValueText).width;

  ctx.font = '500 13px NotoSans';
  let balLabelW = 0;
  for (const ch of balLabel) balLabelW += ctx.measureText(ch).width + 5;
  balLabelW -= 5;

  const balTotalW = balLabelW + 12 + balValueW;
  let bx = W / 2 - balTotalW / 2;

  ctx.textAlign = 'left';
  ctx.fillStyle = PALETTE.muted;
  for (const ch of balLabel) {
    ctx.fillText(ch, bx, y);
    bx += ctx.measureText(ch).width + 5;
  }
  bx += 7;
  ctx.font = '900 24px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  ctx.fillText(balValueText, bx, y);

  const handle = `@${(username || 'shushu').toUpperCase()}`;
  ctx.font = '500 14px NotoSans';
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'right';
  let hx = W - 71;
  const chars = [...handle];
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = ctx.measureText(chars[i]).width;
    ctx.fillText(chars[i], hx, y);
    hx -= w + 5;
  }
}

// ─── Per-column strip + reel plan ────────────────────────────────────────────

// 為每一欄建一條 6 格 strip：把 grid 該欄的 top/mid/bot 放在連續 3 格，
// 剩餘 3 格用 SYMBOLS 補（轉動時當填料），這樣滾到目標時剛好對齊 3 列。
function buildColumnStrip(gridCol) {
  const N = STRIP_LEN;
  const T = 1 + Math.floor(Math.random() * (N - 3)); // 1..N-3 → top visible index
  const strip = new Array(N).fill(null);
  strip[T]     = SYMBOL_BY_ID[gridCol[0].id];
  strip[T + 1] = SYMBOL_BY_ID[gridCol[1].id];
  strip[T + 2] = SYMBOL_BY_ID[gridCol[2].id];
  let p = 0;
  for (let i = 0; i < N; i++) {
    if (strip[i]) continue;
    strip[i] = SYMBOLS[p++ % N];
  }
  return { strip, targetIdx: T };
}

function buildReelPlan({ grid }) {
  const SPIN_BASE   = 4;
  const SPIN_DELTA  = 2;
  const SETTLE_LEN  = 3;
  const SPIN_SPEED  = 170;

  const plans = [];
  for (let c = 0; c < VIEW_COLS; c++) {
    const gridCol = [grid[0][c], grid[1][c], grid[2][c]];
    const { strip, targetIdx } = buildColumnStrip(gridCol);
    const spinFrames = SPIN_BASE + c * SPIN_DELTA;
    const settleStart = spinFrames;
    const settleEnd   = settleStart + SETTLE_LEN;
    const startOffset = c * 137;
    const spinEndOffset = startOffset + spinFrames * SPIN_SPEED;
    const minOff = spinEndOffset + STRIP_H;
    const wraps = Math.ceil((minOff - targetIdx * CELL) / STRIP_H);
    const finalOffset = wraps * STRIP_H + targetIdx * CELL;
    plans.push({
      strip,
      targetIdx,
      spinFrames,
      settleStart,
      settleEnd,
      startOffset,
      spinEndOffset,
      finalOffset,
    });
  }

  const allStoppedAt = Math.max(...plans.map((p) => p.settleEnd));
  const revealStart = allStoppedAt;

  return { plans, spinSpeed: SPIN_SPEED, revealStart };
}

function reelOffsetAtFrame(plan, f, spinSpeed) {
  if (f < plan.settleStart) {
    return plan.startOffset + f * spinSpeed;
  }
  if (f < plan.settleEnd) {
    const t = (f - plan.settleStart) / (plan.settleEnd - plan.settleStart);
    const e = easeOut3(clamp01(t));
    return plan.spinEndOffset + (plan.finalOffset - plan.spinEndOffset) * e;
  }
  return plan.finalOffset;
}

// 把所有中獎 payline 的 cells 攤平成「每欄該亮哪幾列」。
function buildHighlightSets(lines) {
  const perCol = Array.from({ length: VIEW_COLS }, () => new Set());
  for (const ln of lines) {
    if (!ln || ln.payout <= 0) continue;
    for (const [r, c] of ln.cells) {
      perCol[c].add(r);
    }
  }
  return perCol;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * @param {object} data
 * @param {string} data.username
 * @param {Array<Array<{id:string, emoji:string}>>} data.grid  3x3
 * @param {Array<object>} data.lines  每條 payline 的判定結果（含 cells/payout）
 * @param {string} data.matchType
 * @param {string|null} data.matchedSymbol
 * @param {number} data.bet
 * @param {number} data.payout   total payout (base + jackpot bust)
 * @param {number} data.multiplier
 * @param {number} data.balance
 * @param {number|null} [data.jackpotPool]
 * @param {number} [data.jackpotBust]
 * @returns {Promise<Buffer>}
 */
async function generateSlotGif(data) {
  ensureFonts();

  const emojisNeeded = new Set([
    ...SYMBOLS.map((s) => s.emoji),
    '🎉', '🎊', '🍒', '✨', '💸',
    ...(data.jackpotPool != null ? ['💰'] : []),
  ]);
  await Promise.all([...emojisNeeded].map(getEmojiImage));

  const accent = pickAccent(data.matchType);
  const won = data.payout > 0;
  const winLines = (data.lines || []).filter((l) => l.payout > 0);
  const winLineCount = winLines.length;
  const isBust = data.matchType === 'jackpot' && (data.jackpotBust || 0) > 0;
  const showJackpotBanner = data.jackpotPool != null;

  const reelsY0 = showJackpotBanner ? 226 : 174;
  const reelsX0 = (W - REELS_TOTAL_W) / 2;
  const reelsEndY = reelsY0 + REELS_TOTAL_H;

  const resultAreaY = reelsEndY + 14;
  const resultAreaH = FOOTER_Y - 28 - resultAreaY;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const staticCanvas = createCanvas(W, H);
  const sctx = staticCanvas.getContext('2d');
  drawBackground(sctx);
  drawCardFrame(sctx);
  drawHeader(sctx, accent);
  dashedLine(sctx, 71, 141, W - 71, 141, PALETTE.muted, [5, 5]);
  if (showJackpotBanner && !isBust) {
    drawJackpotBanner(sctx, data.jackpotPool, data.jackpotBust || 0, false);
  }
  drawFooter(sctx, {
    bet: data.bet,
    balance: data.balance,
    multiplier: data.multiplier,
    won,
    username: data.username,
  });

  const TOTAL_FRAMES = 13;
  const FRAME_DELAY  = 30;
  const HOLD_DELAY   = 80;

  const { plans, spinSpeed, revealStart } = buildReelPlan({ grid: data.grid });
  const highlightSets = buildHighlightSets(data.lines || []);

  // octree palette 比 neuquant 快很多（單張省約 30–40%），對拉霸的固定色板已夠用。
  const encoder = new GIFEncoder(W, H, 'octree', true, TOTAL_FRAMES);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  const YIELD_EVERY = 6;
  let frameCount = 0;

  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const inReveal = f >= revealStart;

    if (f === TOTAL_FRAMES - 1)         encoder.setDelay(HOLD_DELAY * 2);
    else if (f >= TOTAL_FRAMES - 3)     encoder.setDelay(HOLD_DELAY);
    else                                encoder.setDelay(FRAME_DELAY);

    ctx.drawImage(staticCanvas, 0, 0);

    if (showJackpotBanner && isBust) {
      drawJackpotBanner(ctx, data.jackpotPool, data.jackpotBust || 0, inReveal);
    }

    const revealLocal = inReveal ? f - revealStart : 0;
    const pulse = inReveal ? 0.5 + 0.5 * Math.sin(revealLocal * 0.9) : 0;

    for (let c = 0; c < VIEW_COLS; c++) {
      const rx = reelsX0 + c * (CELL + REEL_GAP);
      const offset = reelOffsetAtFrame(plans[c], f, spinSpeed);
      const highlights = inReveal && won ? highlightSets[c] : null;
      drawReelBox(
        ctx,
        rx,
        reelsY0,
        offset,
        plans[c].strip,
        accent,
        highlights,
        pulse,
      );
    }

    drawResultPanel(ctx, {
      phase: inReveal ? 'reveal' : 'spinning',
      matchType: data.matchType,
      payout: data.payout,
      accent,
      areaY: resultAreaY,
      areaH: resultAreaH,
      winLineCount,
    });

    encoder.addFrame(ctx);
    frameCount++;
    if (frameCount % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generateSlotGif;
