const { stockSystem } = require("../../config");

function gaussian() {
  // Box-Muller
  let u1 = Math.random();
  let u2 = Math.random();
  if (u1 < Number.EPSILON) u1 = Number.EPSILON;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function roundPrice(p) {
  return Math.round(p * 10) / 10;
}

function calcMarketDrift(sentiment) {
  const drifts = stockSystem?.marketDrift || { bull: 0.001, bear: -0.001, sideways: 0 };
  if (sentiment === "bull") return drifts.bull ?? 0.001;
  if (sentiment === "bear") return drifts.bear ?? -0.001;
  return drifts.sideways ?? 0;
}

function nextPrice(lastPrice, sigma, drift, floor) {
  const epsilon = gaussian();
  const raw = lastPrice * (1 + (drift || 0) + (sigma || 0) * epsilon);
  return Math.max(floor || 1, roundPrice(raw));
}

function applyEvent(currentPrice, effectRate, floor) {
  const raw = currentPrice * (1 + (effectRate || 0));
  return Math.max(floor || 1, roundPrice(raw));
}

// 交易衝擊：買單把價格頂上去、賣單砸下來。衝擊幅度隨股數線性增加，
// 但單筆最多推動 maxStepFrac（避免一張大單瞬間拉爆）。
function priceImpact(currentPrice, shares, side, cfg, floor) {
  if (!cfg?.enabled || !(shares > 0)) return { price: currentPrice, delta: 0, frac: 0 };
  const perShare = cfg.perShareFrac ?? 0;
  const maxStep = cfg.maxStepFrac ?? 0.06;
  const frac = Math.min(maxStep, shares * perShare);
  const dir = side === "buy" ? 1 : -1;
  const raw = currentPrice * (1 + dir * frac);
  const price = Math.max(floor || 1, roundPrice(raw));
  return { price, delta: roundPrice(price - currentPrice), frac };
}

// 當日漲跌停界線：以參考價（當日開盤價）為基準的 ±limitPct。
function limitBounds(refPrice, cfg) {
  if (!cfg?.enabled || !(refPrice > 0)) return null;
  const pct = cfg.limitPct ?? 0.1;
  return {
    up: roundPrice(refPrice * (1 + pct)),
    down: roundPrice(refPrice * (1 - pct)),
    pct,
  };
}

function clampToLimit(price, refPrice, cfg) {
  const b = limitBounds(refPrice, cfg);
  if (!b) return price;
  return Math.min(b.up, Math.max(b.down, price));
}

module.exports = {
  nextPrice,
  applyEvent,
  calcMarketDrift,
  roundPrice,
  priceImpact,
  limitBounds,
  clampToLimit,
};
