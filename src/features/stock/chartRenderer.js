const path = require("path");
const { createCanvas, registerFont } = require("canvas");

const FONT_DIR = path.join(__dirname, "../../../fonts");
let fontsLoaded = false;
function ensureFonts() {
  if (fontsLoaded) return;
  try {
    registerFont(path.join(FONT_DIR, "NotoSansJP-Black.otf"), { family: "NotoSans", weight: "900" });
    registerFont(path.join(FONT_DIR, "NotoSansJP-Medium.otf"), { family: "NotoSans", weight: "400" });
  } catch (e) {
    // 字體載入失敗，回退到系統字體；不阻斷渲染
  }
  fontsLoaded = true;
}

const SERIES_COLORS = ["#3498db", "#e67e22", "#9b59b6", "#2ecc71", "#e74c3c", "#f1c40f", "#1abc9c"];

// series: [{ symbol, name, points: [{ price, timestamp }, ...] }]
// opts.stats: [{ symbol, name, price, changePct, weekHigh, weekLow, volume, netVol, limit }]
//   有給就在走勢圖下方加一張完整數據表（欄位對齊，資訊不必塞進訊息文字）。
function renderMultiLine(series, opts = {}) {
  ensureFonts();
  const stats = Array.isArray(opts.stats) && opts.stats.length ? opts.stats : null;
  const W = opts.width || 900;
  const padL = 60;
  const padR = 24;
  const padT = 40;

  // 有數據表時：繪圖區固定高度，表格接在下方；沒有時維持原本行為
  const chartH = opts.chartHeight || 300;
  const rowH = 28;
  const tableHeaderH = 30;
  const tableGap = 18;
  const padB = stats ? 16 : 48;
  const tableH = stats ? tableHeaderH + stats.length * rowH : 0;
  const H = stats ? padT + chartH + tableGap + tableH + padB : opts.height || 400;
  const plotH = stats ? chartH : H - padT - padB;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // 背景
  ctx.fillStyle = "#1e1f29";
  ctx.fillRect(0, 0, W, H);

  // 標題
  ctx.fillStyle = "#ecf0f1";
  ctx.font = "bold 18px NotoSans, sans-serif";
  ctx.fillText(opts.title || "股價走勢", padL, 26);

  // 計算 Y 軸範圍（多支股票用同一座標，先正規化）
  // 為了讓不同價位的股票能同畫面比較，這裡用「相對首點百分比」
  const normalized = series.map((s) => {
    const pts = s.points || [];
    if (pts.length === 0) return { ...s, normPoints: [] };
    const base = pts[0].price || 1;
    return {
      ...s,
      normPoints: pts.map((p) => ({ ...p, normValue: (p.price / base - 1) * 100 })),
    };
  });

  const allValues = normalized.flatMap((s) => s.normPoints.map((p) => p.normValue));
  let minY = allValues.length ? Math.min(...allValues, 0) : -5;
  let maxY = allValues.length ? Math.max(...allValues, 0) : 5;
  if (maxY - minY < 4) {
    const mid = (maxY + minY) / 2;
    minY = mid - 2;
    maxY = mid + 2;
  }
  const yPad = (maxY - minY) * 0.1;
  minY -= yPad;
  maxY += yPad;

  const maxPoints = Math.max(2, ...normalized.map((s) => s.normPoints.length));

  const plotW = W - padL - padR;

  // 繪格線
  ctx.strokeStyle = "#3a3b46";
  ctx.lineWidth = 1;
  ctx.font = "11px NotoSans, sans-serif";
  ctx.fillStyle = "#7f8c8d";
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    const v = maxY - ((maxY - minY) * i) / gridLines;
    ctx.fillText(`${v >= 0 ? "+" : ""}${v.toFixed(1)}%`, 8, y + 4);
  }

  // 零線（基準）
  if (minY <= 0 && maxY >= 0) {
    const y0 = padT + (plotH * (maxY - 0)) / (maxY - minY);
    ctx.strokeStyle = "#7f8c8d";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y0);
    ctx.lineTo(W - padR, y0);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 畫線
  normalized.forEach((s, idx) => {
    const color = SERIES_COLORS[idx % SERIES_COLORS.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.normPoints.forEach((p, i) => {
      const x = padL + (plotW * i) / Math.max(1, maxPoints - 1);
      const y = padT + (plotH * (maxY - p.normValue)) / (maxY - minY);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  if (stats) {
    drawStatsTable(ctx, stats, {
      x: 24,
      y: padT + plotH + tableGap,
      w: W - 48,
      rowH,
      headerH: tableHeaderH,
      colorFor: (i) => SERIES_COLORS[i % SERIES_COLORS.length],
    });
  } else {
    // Legend
    ctx.font = "12px NotoSans, sans-serif";
    let lx = padL;
    const ly = H - 18;
    normalized.forEach((s, idx) => {
      const color = SERIES_COLORS[idx % SERIES_COLORS.length];
      ctx.fillStyle = color;
      ctx.fillRect(lx, ly - 9, 12, 12);
      ctx.fillStyle = "#ecf0f1";
      const label = `${s.symbol} ${s.name || ""}`;
      ctx.fillText(label, lx + 16, ly + 1);
      lx += ctx.measureText(label).width + 38;
    });
  }

  return canvas.toBuffer("image/png");
}

// 走勢圖下方的完整數據表：色塊｜代號 名稱｜現價｜今日%｜週高｜週低｜今日量｜淨買賣
function drawStatsTable(ctx, stats, { x, y, w, rowH, headerH, colorFor }) {
  const right = x + w;
  // 欄位右緣（數值欄右對齊）／左緣（文字欄左對齊）
  const COL = {
    swatch: x + 2,
    symbol: x + 24,
    name: x + 96,
    price: right - 430,
    chg: right - 320,
    high: right - 210,
    low: right - 120,
    vol: right - 8,
  };

  // 表頭
  ctx.font = "bold 13px NotoSans, sans-serif";
  ctx.fillStyle = "#95a5a6";
  const hy = y + 20;
  ctx.textAlign = "left";
  ctx.fillText("代號", COL.symbol, hy);
  ctx.fillText("名稱", COL.name, hy);
  ctx.textAlign = "right";
  ctx.fillText("現價", COL.price, hy);
  ctx.fillText("今日%", COL.chg, hy);
  ctx.fillText("週高", COL.high, hy);
  ctx.fillText("週低", COL.low, hy);
  ctx.fillText("今日量", COL.vol, hy);
  ctx.textAlign = "left";

  ctx.strokeStyle = "#3a3b46";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + headerH - 4);
  ctx.lineTo(right, y + headerH - 4);
  ctx.stroke();

  stats.forEach((s, i) => {
    const rowY = y + headerH + i * rowH;
    const baseY = rowY + 19;
    if (i % 2 === 1) {
      ctx.fillStyle = "#252631";
      ctx.fillRect(x, rowY, w, rowH);
    }
    // 色塊（對應走勢圖線色）
    ctx.fillStyle = colorFor(i);
    ctx.fillRect(COL.swatch, baseY - 11, 12, 12);

    ctx.font = "bold 13px NotoSans, sans-serif";
    ctx.fillStyle = "#ecf0f1";
    ctx.textAlign = "left";
    ctx.fillText(s.symbol, COL.symbol, baseY);
    ctx.font = "13px NotoSans, sans-serif";
    ctx.fillStyle = "#bdc3c7";
    let nm = s.name || "";
    while (nm && ctx.measureText(nm).width > COL.price - COL.name - 40) nm = nm.slice(0, -1);
    const limitTag = s.limit === "up" ? " 🔺" : s.limit === "down" ? " 🔻" : "";
    ctx.fillText(nm + limitTag, COL.name, baseY);

    ctx.textAlign = "right";
    ctx.fillStyle = "#ecf0f1";
    ctx.font = "13px NotoSans, sans-serif";
    ctx.fillText(s.price.toFixed(1), COL.price, baseY);

    const up = s.changePct >= 0;
    ctx.fillStyle = s.changePct === 0 ? "#95a5a6" : up ? "#2ecc71" : "#e74c3c";
    ctx.fillText(`${up ? "+" : ""}${s.changePct.toFixed(2)}%`, COL.chg, baseY);

    ctx.fillStyle = "#7f8c8d";
    ctx.fillText(s.weekHigh.toFixed(1), COL.high, baseY);
    ctx.fillText(s.weekLow.toFixed(1), COL.low, baseY);

    ctx.fillStyle = "#bdc3c7";
    const volText = s.volume > 0
      ? `${s.volume.toLocaleString()}${s.netVol > 0 ? " ↑" : s.netVol < 0 ? " ↓" : ""}`
      : "—";
    ctx.fillText(volText, COL.vol, baseY);
    ctx.textAlign = "left";
  });
}

// 單股 K 線/走勢圖（折線版本，價格直接顯示）
// opts.volumeBuckets: [{ buyShares, sellShares }, ...] 有給就在下方加副圖區疊量柱。
function renderSingleLine(symbol, name, points, opts = {}) {
  ensureFonts();
  const hasVolume =
    Array.isArray(opts.volumeBuckets) && opts.volumeBuckets.length > 0;
  const W = opts.width || 900;
  const H = opts.height || (hasVolume ? 520 : 400);
  const padL = 64;
  const padR = 24;
  const padT = 40;
  const padB = 48;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1e1f29";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ecf0f1";
  ctx.font = "bold 18px NotoSans, sans-serif";
  ctx.fillText(opts.title || `${symbol} ${name || ""} 走勢`, padL, 26);

  const pts = points || [];
  if (pts.length === 0) {
    ctx.fillStyle = "#7f8c8d";
    ctx.font = "14px NotoSans, sans-serif";
    ctx.fillText("（無歷史資料）", W / 2 - 50, H / 2);
    return canvas.toBuffer("image/png");
  }

  // 上下分區：價格圖佔 70%，量柱副圖佔 25%，中間留 5% 間距
  const plotW = W - padL - padR;
  const totalPlotH = H - padT - padB;
  const priceH = hasVolume ? Math.floor(totalPlotH * 0.7) : totalPlotH;
  const gapH = hasVolume ? Math.floor(totalPlotH * 0.05) : 0;
  const volumeH = hasVolume ? totalPlotH - priceH - gapH : 0;
  const volumeTop = padT + priceH + gapH;

  const prices = pts.map((p) => p.price);
  let minY = Math.min(...prices);
  let maxY = Math.max(...prices);
  if (maxY - minY < 0.5) {
    maxY += 1;
    minY -= 1;
  }
  const yPad = (maxY - minY) * 0.1;
  minY -= yPad;
  maxY += yPad;

  ctx.strokeStyle = "#3a3b46";
  ctx.lineWidth = 1;
  ctx.font = "11px NotoSans, sans-serif";
  ctx.fillStyle = "#7f8c8d";
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (priceH * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    const v = maxY - ((maxY - minY) * i) / gridLines;
    ctx.fillText(v.toFixed(1), 8, y + 4);
  }

  const first = prices[0];
  const last = prices[prices.length - 1];
  const trendUp = last >= first;
  ctx.strokeStyle = trendUp ? "#2ecc71" : "#e74c3c";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = padL + (plotW * i) / Math.max(1, pts.length - 1);
    const y = padT + (priceH * (maxY - p.price)) / (maxY - minY);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 最新價標籤
  ctx.fillStyle = "#ecf0f1";
  ctx.font = "bold 14px NotoSans, sans-serif";
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  const sign = pct >= 0 ? "+" : "";
  ctx.fillText(`${last.toFixed(1)} (${sign}${pct.toFixed(2)}%)`, W - padR - 140, 26);

  if (hasVolume) {
    drawVolumePanel(ctx, opts.volumeBuckets, {
      x: padL,
      y: volumeTop,
      w: plotW,
      h: volumeH,
    });
  }

  return canvas.toBuffer("image/png");
}

function drawVolumePanel(ctx, buckets, { x, y, w, h }) {
  // 副圖背景與框
  ctx.strokeStyle = "#3a3b46";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();

  const maxVol = Math.max(
    1,
    ...buckets.map((b) => (b.buyShares || 0) + (b.sellShares || 0)),
  );

  ctx.fillStyle = "#7f8c8d";
  ctx.font = "10px NotoSans, sans-serif";
  ctx.fillText("成交量", 8, y + 12);
  ctx.fillText(maxVol.toLocaleString(), 8, y + 24);

  const n = buckets.length;
  const slotW = w / n;
  const barW = Math.max(2, slotW * 0.7);
  const barOffset = (slotW - barW) / 2;

  buckets.forEach((b, i) => {
    const total = (b.buyShares || 0) + (b.sellShares || 0);
    if (total === 0) return;
    const totalBarH = (h - 4) * (total / maxVol);
    const buyRatio = (b.buyShares || 0) / total;
    const buyH = totalBarH * buyRatio;
    const sellH = totalBarH - buyH;
    const baseY = y + h;
    const xPos = x + i * slotW + barOffset;

    if (sellH > 0) {
      ctx.fillStyle = "#e74c3c";
      ctx.fillRect(xPos, baseY - sellH, barW, sellH);
    }
    if (buyH > 0) {
      ctx.fillStyle = "#2ecc71";
      ctx.fillRect(xPos, baseY - sellH - buyH, barW, buyH);
    }
  });

  // 量柱 legend
  ctx.font = "11px NotoSans, sans-serif";
  let lx = x + w - 130;
  const ly = y + 12;
  ctx.fillStyle = "#2ecc71";
  ctx.fillRect(lx, ly - 9, 10, 10);
  ctx.fillStyle = "#ecf0f1";
  ctx.fillText("買", lx + 14, ly);
  lx += 38;
  ctx.fillStyle = "#e74c3c";
  ctx.fillRect(lx, ly - 9, 10, 10);
  ctx.fillStyle = "#ecf0f1";
  ctx.fillText("賣", lx + 14, ly);
}

module.exports = {
  renderMultiLine,
  renderSingleLine,
};
