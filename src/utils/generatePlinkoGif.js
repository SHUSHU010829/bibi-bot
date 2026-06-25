// 彈珠台（Plinko）結果 GIF：球從頂端逐排掉落、拖金色軌跡、彈進命中格後停住。
// 用 canvas 2D 直接畫（與輪盤／拉霸 GIF 同套：gif-encoder-2 + node-canvas）。
// 播一次就停（setRepeat(0)），最後幾幀定格在結果。

const path = require("path");
const { createCanvas, registerFont } = require("canvas");
const GIFEncoder = require("gif-encoder-2");

const FONT_DIR = path.join(__dirname, "../../fonts");
let fontsLoaded = false;
function ensureFonts() {
  if (fontsLoaded) return;
  registerFont(path.join(FONT_DIR, "NotoSansJP-Black.otf"), { family: "NotoSans", weight: "900" });
  registerFont(path.join(FONT_DIR, "NotoSansJP-Medium.otf"), { family: "NotoSans", weight: "500" });
  fontsLoaded = true;
}

const W = 760;
const H = 700;
const MARGIN = 56;

const SEG_FRAMES = 4; // 每排幾幀
const SETTLE_FRAMES = 4; // 彈進落點格
const STILL_FRAMES = 8; // 停在結果

function palette(win) {
  return {
    bg: "#0E1A1C",
    panel: "#14292C",
    ink: "#F4ECD8",
    muted: "#86B0B2",
    accent: "#FFD84D",
    peg: "#4E6468",
    trail: win ? "#FFD84D" : "#FF9A66",
    ball: win ? "#FFD84D" : "#FF6E7A",
    result: win ? "#5BD68A" : "#FF6E7A",
  };
}

function bucketColor(m) {
  if (m >= 5) return "#C9302C";
  if (m >= 2) return "#E08A2B";
  if (m >= 1) return "#3D6F6A";
  return "#3A3A44";
}
function bucketFg(m) {
  return m >= 2 ? "#FFF4E0" : m >= 1 ? "#F4ECD8" : "#B8B8C4";
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function generatePlinkoGif(result, opts = {}) {
  ensureFonts();
  const { username, balance } = opts;
  const win = result.payout > result.bet;
  const P = palette(win);

  const R = result.rows;
  const buckets = R + 1;
  const boardWmax = W - MARGIN * 2;
  const cw = Math.floor(boardWmax / buckets);
  const boardW = cw * buckets;
  const boardLeft = Math.round((W - boardW) / 2);
  const boardCx = boardLeft + boardW / 2;

  const boardTop = 158;
  const sy = 40;
  const boardBottom = boardTop + R * sy;
  const bucketTop = boardBottom + 16;
  const bucketH = 50;

  const PEG_R = 4;
  const BALL_R = 11;

  const nodeX = (j, p) => boardCx + (2 * p - j) * (cw / 2);
  const nodeY = (j) => boardTop + j * sy;

  // 落球各層的格點（含起點 j=0）。
  let rights = 0;
  const pts = [[nodeX(0, 0), nodeY(0)]];
  for (let j = 0; j < R; j += 1) {
    if (result.path[j] === "R") rights += 1;
    pts.push([nodeX(j + 1, rights), nodeY(j + 1)]);
  }
  const landX = pts[pts.length - 1][0];

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const TOTAL = R * SEG_FRAMES + SETTLE_FRAMES + STILL_FRAMES;
  const encoder = new GIFEncoder(W, H, "neuquant", true, TOTAL);
  encoder.setDelay(50); // 20 fps
  encoder.setRepeat(0); // 播一次就停
  encoder.setQuality(20);
  encoder.start();

  // 畫一幀：ballXY = 球座標，progressPts = 已走過的折線點，showResult = 顯示結果文字。
  function drawFrame(ballXY, progressPts, showResult) {
    // 背景
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    // 外白框
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(MARGIN / 2, MARGIN / 2, W - MARGIN, H - MARGIN);

    // 標題
    ctx.fillStyle = P.accent;
    ctx.fillRect(MARGIN / 2 + 18, 26, 50, 50);
    ctx.fillStyle = P.bg;
    ctx.font = "900 22px NotoSans";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PK", MARGIN / 2 + 43, 52);
    ctx.fillStyle = P.ink;
    ctx.font = "900 30px NotoSans";
    ctx.textAlign = "left";
    ctx.fillText("彈 珠 台", MARGIN / 2 + 84, 52);
    ctx.fillStyle = P.muted;
    ctx.font = "500 16px NotoSans";
    ctx.textAlign = "right";
    ctx.fillText("逼逼賭場", W - MARGIN / 2 - 18, 52);

    // 結果倍率（頂部置中，球掉落時先不顯示）
    if (showResult) {
      ctx.fillStyle = P.result;
      ctx.font = "900 30px NotoSans";
      ctx.textAlign = "center";
      ctx.fillText(`命中 ×${result.multiplier}`, W / 2, 112);
    } else {
      ctx.fillStyle = P.muted;
      ctx.font = "500 20px NotoSans";
      ctx.textAlign = "center";
      ctx.fillText("下注 " + result.bet.toLocaleString(), W / 2, 112);
    }

    // 板面底
    ctx.fillStyle = P.panel;
    ctx.fillRect(boardLeft, boardTop - 12, boardW, boardBottom - boardTop + 24);

    // 釘
    ctx.fillStyle = P.peg;
    for (let j = 1; j <= R; j += 1) {
      for (let p = 0; p <= j; p += 1) {
        ctx.beginPath();
        ctx.arc(nodeX(j, p), nodeY(j), PEG_R, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 軌跡
    if (progressPts.length >= 2) {
      ctx.strokeStyle = P.trail;
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(progressPts[0][0], progressPts[0][1]);
      for (let i = 1; i < progressPts.length; i += 1) {
        ctx.lineTo(progressPts[i][0], progressPts[i][1]);
      }
      ctx.stroke();
    }

    // 球
    ctx.fillStyle = P.ball;
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ballXY[0], ballXY[1], BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 落點格
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < result.row.length; i += 1) {
      const m = result.row[i];
      const bx = boardLeft + i * cw;
      const hit = showResult && i === result.bucket;
      ctx.fillStyle = bucketColor(m);
      ctx.fillRect(bx + 2, bucketTop, cw - 4, bucketH);
      if (hit) {
        ctx.strokeStyle = P.accent;
        ctx.lineWidth = 4;
        ctx.strokeRect(bx + 2, bucketTop, cw - 4, bucketH);
      }
      ctx.fillStyle = bucketFg(m);
      ctx.font = `900 ${m >= 100 ? 15 : 18}px NotoSans`;
      ctx.fillText(`${m}x`, bx + cw / 2, bucketTop + bucketH / 2 + 1);
    }

    // 頁尾
    const footY = bucketTop + bucketH + 46;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = P.ink;
    ctx.font = "900 20px NotoSans";
    ctx.fillText(username || "玩家", MARGIN / 2 + 18, footY);

    if (showResult) {
      const net = result.payout - result.bet;
      const sign = net > 0 ? "＋" : net < 0 ? "－" : "±";
      ctx.textAlign = "right";
      ctx.fillStyle = P.muted;
      ctx.font = "500 14px NotoSans";
      ctx.fillText("淨輸贏", W - MARGIN / 2 - 168, footY - 22);
      ctx.fillText("餘額", W - MARGIN / 2 - 18, footY - 22);
      ctx.fillStyle = P.result;
      ctx.font = "900 22px NotoSans";
      ctx.fillText(`${sign}${Math.abs(net).toLocaleString()}`, W - MARGIN / 2 - 168, footY);
      ctx.fillStyle = P.ink;
      ctx.fillText(typeof balance === "number" ? balance.toLocaleString() : "—", W - MARGIN / 2 - 18, footY);
    }
  }

  let frameCount = 0;
  async function addFrame() {
    encoder.addFrame(ctx);
    frameCount += 1;
    // 每 4 幀讓出事件迴圈，避免 CPU 連續阻塞造成互動逾期（10062）。
    if (frameCount % 4 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // 掉落：逐段插值
  for (let seg = 0; seg < R; seg += 1) {
    const [ax, ay] = pts[seg];
    const [bx, by] = pts[seg + 1];
    for (let f = 0; f < SEG_FRAMES; f += 1) {
      const e = easeInOut((f + 1) / SEG_FRAMES);
      const x = ax + (bx - ax) * e;
      const y = ay + (by - ay) * e;
      const progress = pts.slice(0, seg + 1).concat([[x, y]]);
      drawFrame([x, y], progress, false);
      await addFrame();
    }
  }

  // 彈進落點格
  const [px, py] = pts[pts.length - 1];
  const targetY = bucketTop + bucketH / 2;
  for (let f = 0; f < SETTLE_FRAMES; f += 1) {
    const e = easeInOut((f + 1) / SETTLE_FRAMES);
    const y = py + (targetY - py) * e;
    drawFrame([landX, y], pts, false);
    await addFrame();
  }

  // 停住結果
  for (let f = 0; f < STILL_FRAMES; f += 1) {
    drawFrame([landX, targetY], pts, true);
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generatePlinkoGif;
