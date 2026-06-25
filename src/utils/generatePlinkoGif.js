// 彈珠台（Plinko）結果 GIF：球從頂端逐排掉落，碰到釘子就往縫隙偏折（拋物線
// 彈跳，不是直線），拖金色軌跡、彈進命中格後停住。
// canvas 2D + gif-encoder-2（與輪盤／拉霸 GIF 同套）。播一次就停。

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
const H = 720;
const MARGIN = 56;
const FRAME = MARGIN / 2; // 白框內縮

const SUB = 10; // 每段拋物線取樣點
const DROP_FRAMES = 34;
const SETTLE_FRAMES = 4;
const STILL_FRAMES = 8;

function palette(win) {
  return {
    bg: "#0E1A1C",
    ink: "#F4ECD8",
    muted: "#86B0B2",
    accent: "#FFD84D",
    panel: "#14292C",
    peg: "#5E767A",
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

// 二次貝茲：A→B，控制點 C。
function bezier(A, C, B, t) {
  const u = 1 - t;
  return [
    u * u * A[0] + 2 * u * t * C[0] + t * t * B[0],
    u * u * A[1] + 2 * u * t * C[1] + t * t * B[1],
  ];
}

async function generatePlinkoGif(result, opts = {}) {
  ensureFonts();
  const { username, balance } = opts;
  const win = result.payout > result.bet;
  const P = palette(win);

  const R = result.rows;
  const buckets = R + 1;
  const cw = Math.floor((W - MARGIN * 2) / buckets);
  const boardW = cw * buckets;
  const boardLeft = Math.round((W - boardW) / 2);
  const boardCx = boardLeft + boardW / 2;

  const boardTop = 176;
  const sy = 40;
  const boardBottom = boardTop + R * sy;
  const bucketTop = boardBottom + 16;
  const bucketH = 50;

  const PEG_R = 4;
  const BALL_R = 12;

  const nodeX = (j, p) => boardCx + (2 * p - j) * (cw / 2);
  const nodeY = (j) => boardTop + j * sy;

  // 落球各層的釘點。
  let rights = 0;
  const pegPts = [[nodeX(0, 0), nodeY(0)]];
  for (let j = 0; j < R; j += 1) {
    if (result.path[j] === "R") rights += 1;
    pegPts.push([nodeX(j + 1, rights), nodeY(j + 1)]);
  }
  const landX = pegPts[pegPts.length - 1][0];

  // 取樣成平滑彈跳軌跡：每段用「先側移再落下」的拋物線（控制點 = (B.x, A.y)），
  // 在每個釘點留下明顯偏折，看起來像撞到釘子彈進縫隙。
  const samples = [pegPts[0]];
  for (let i = 0; i < R; i += 1) {
    const A = pegPts[i];
    const B = pegPts[i + 1];
    const C = [B[0], A[1]];
    for (let k = 1; k <= SUB; k += 1) {
      samples.push(bezier(A, C, B, k / SUB));
    }
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const TOTAL = DROP_FRAMES + SETTLE_FRAMES + STILL_FRAMES;
  const encoder = new GIFEncoder(W, H, "neuquant", true, TOTAL);
  encoder.setDelay(50);
  encoder.setRepeat(0);
  encoder.setQuality(20);
  encoder.start();

  function drawFrame(ballXY, trailPts, showResult) {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 3;
    ctx.strokeRect(FRAME, FRAME, W - MARGIN, H - MARGIN);

    // 標題（往下挪，不貼白框）
    ctx.fillStyle = P.accent;
    ctx.fillRect(FRAME + 22, 50, 52, 52);
    ctx.fillStyle = P.bg;
    ctx.font = "900 22px NotoSans";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PK", FRAME + 48, 77);
    ctx.fillStyle = P.ink;
    ctx.font = "900 32px NotoSans";
    ctx.textAlign = "left";
    ctx.fillText("彈 珠 台", FRAME + 90, 77);
    ctx.fillStyle = P.muted;
    ctx.font = "500 16px NotoSans";
    ctx.textAlign = "right";
    ctx.fillText("逼逼賭場", W - FRAME - 20, 77);

    // 標頭資訊
    ctx.textAlign = "center";
    if (showResult) {
      ctx.fillStyle = P.result;
      ctx.font = "900 30px NotoSans";
      ctx.fillText(`命中 ×${result.multiplier}`, W / 2, 138);
    } else {
      ctx.fillStyle = P.muted;
      ctx.font = "500 20px NotoSans";
      ctx.fillText("下注 " + result.bet.toLocaleString(), W / 2, 138);
    }

    // 板面
    ctx.fillStyle = P.panel;
    ctx.fillRect(boardLeft, boardTop - 14, boardW, boardBottom - boardTop + 28);

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
    if (trailPts.length >= 2) {
      ctx.strokeStyle = P.trail;
      ctx.lineWidth = 4;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(trailPts[0][0], trailPts[0][1]);
      for (let i = 1; i < trailPts.length; i += 1) ctx.lineTo(trailPts[i][0], trailPts[i][1]);
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
      ctx.fillStyle = bucketColor(m);
      ctx.fillRect(bx + 2, bucketTop, cw - 4, bucketH);
      if (showResult && i === result.bucket) {
        ctx.strokeStyle = P.accent;
        ctx.lineWidth = 4;
        ctx.strokeRect(bx + 2, bucketTop, cw - 4, bucketH);
      }
      ctx.fillStyle = bucketFg(m);
      ctx.font = `900 ${m >= 100 ? 15 : 18}px NotoSans`;
      ctx.fillText(`${m}x`, bx + cw / 2, bucketTop + bucketH / 2 + 1);
    }

    // 頁尾
    const footY = bucketTop + bucketH + 56;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = P.ink;
    ctx.font = "900 20px NotoSans";
    ctx.fillText(username || "玩家", FRAME + 20, footY);

    if (showResult) {
      const net = result.payout - result.bet;
      const sign = net > 0 ? "＋" : net < 0 ? "－" : "±";
      ctx.textAlign = "right";
      ctx.fillStyle = P.muted;
      ctx.font = "500 14px NotoSans";
      ctx.fillText("淨輸贏", W - FRAME - 178, footY - 24);
      ctx.fillText("餘額", W - FRAME - 20, footY - 24);
      ctx.fillStyle = P.result;
      ctx.font = "900 22px NotoSans";
      ctx.fillText(`${sign}${Math.abs(net).toLocaleString()}`, W - FRAME - 178, footY);
      ctx.fillStyle = P.ink;
      ctx.fillText(typeof balance === "number" ? balance.toLocaleString() : "—", W - FRAME - 20, footY);
    }
  }

  let frameCount = 0;
  async function addFrame() {
    encoder.addFrame(ctx);
    frameCount += 1;
    if (frameCount % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  // 掉落：沿取樣軌跡前進
  const last = samples.length - 1;
  for (let f = 0; f < DROP_FRAMES; f += 1) {
    const idx = Math.round((f / (DROP_FRAMES - 1)) * last);
    drawFrame(samples[idx], samples.slice(0, idx + 1), false);
    await addFrame();
  }

  // 彈進落點格
  const startY = pegPts[pegPts.length - 1][1];
  const targetY = bucketTop + bucketH / 2;
  for (let f = 0; f < SETTLE_FRAMES; f += 1) {
    const e = (f + 1) / SETTLE_FRAMES;
    drawFrame([landX, startY + (targetY - startY) * e], samples, false);
    await addFrame();
  }

  // 停住結果
  for (let f = 0; f < STILL_FRAMES; f += 1) {
    drawFrame([landX, targetY], samples, true);
    await addFrame();
  }

  encoder.finish();
  return encoder.out.getData();
}

module.exports = generatePlinkoGif;
