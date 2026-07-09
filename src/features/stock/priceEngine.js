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

// 個股調校參數以 config pool 為單一來源（sigma / beta），改數值只需編輯
// stocks.json，不必動 DB。找不到才回退到 DB doc 上的舊值。
function poolParams(symbol) {
  return (stockSystem?.pool || []).find((p) => p.symbol === symbol) || null;
}

// 掛牌價（合理價的錨點）：現役 + 候補 pool 為單一來源。下市補位的候補股
// 不在 pool，故需一併查 candidatePool，否則錨定會失效。
function poolInitialPrice(symbol) {
  const all = [...(stockSystem?.pool || []), ...(stockSystem?.candidatePool || [])];
  return all.find((p) => p.symbol === symbol)?.initialPrice ?? null;
}

// 個股實際 drift = beta × 市場情緒 drift。beta 高的股票對牛熊放大反應，
// beta 低的（藍籌）相對抗漲抗跌。beta 未設 → 1（等同原本行為）。
function stockDrift(symbol, sentiment) {
  const beta = poolParams(symbol)?.beta ?? 1;
  return beta * calcMarketDrift(sentiment);
}

function nextPrice(lastPrice, sigma, drift, floor) {
  const epsilon = gaussian();
  const raw = lastPrice * (1 + (drift || 0) + (sigma || 0) * epsilon);
  return Math.max(floor || 1, roundPrice(raw));
}

function engineCfg() {
  return stockSystem?.engine || {};
}

function poolOverride(symbol, key) {
  const p = poolParams(symbol);
  return p && p[key] != null ? p[key] : null;
}

// 進階價格步進：drift + 動能(趨勢延續) + 均值回歸(拉回合理價) + 雜訊。
// 回傳 { price, momentum }；momentum 為報酬的 EMA，需回寫個股 doc 供下一 tick 使用。
function nextPriceAdvanced(state, params) {
  const { lastPrice, momentum = 0, fairValue } = state;
  const { sigma, drift, floor, symbol } = params;
  const cfg = engineCfg();
  const mom = cfg.momentum || {};
  const rev = cfg.reversion || {};
  const rho = mom.rho ?? 0.9;
  const gamma = mom.enabled === false ? 0 : (poolOverride(symbol, "gamma") ?? mom.gamma ?? 0);
  const kappa = rev.enabled === false ? 0 : (poolOverride(symbol, "kappa") ?? rev.kappa ?? 0);

  const epsilon = gaussian();
  let r = (drift || 0) + gamma * momentum + (sigma || 0) * epsilon;
  if (kappa > 0 && fairValue > 0 && lastPrice > 0) {
    r += kappa * Math.log(fairValue / lastPrice);
  }
  const raw = lastPrice * (1 + r);
  const price = Math.max(floor || 1, roundPrice(raw));
  const newMomentum = rho * momentum + (1 - rho) * r;
  return { price, momentum: newMomentum };
}

// 合理價每日依情緒微幅位移（牛市上修、熊市下修），並緩步向掛牌價 anchor 收斂。
// anchor 收斂是為了修復下市崩盤把 fairValue 砍到地板後永遠回不來的問題：
// 只要傳入 anchor（掛牌價），偏離的 fairValue 會每日補一小段回歸，均值回歸才有往上的動力。
// 整理期（warning）的個股刻意不傳 anchor，讓 fairValue 續黏地板、維持下市張力。
function nextFairValue(fairValue, sentiment, anchor) {
  const cfg = engineCfg();
  const d = cfg.fairValueDailyDrift ?? 0;
  const dir = sentiment === "bull" ? 1 : sentiment === "bear" ? -1 : 0;
  let fv = (fairValue || 0) * (1 + dir * d);
  const pull = cfg.fairValueAnchorPull ?? 0;
  if (pull > 0 && anchor > 0 && fv > 0) {
    fv += (anchor - fv) * pull;
  }
  return roundPrice(fv);
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
  nextPriceAdvanced,
  nextFairValue,
  applyEvent,
  calcMarketDrift,
  poolParams,
  poolInitialPrice,
  stockDrift,
  roundPrice,
  priceImpact,
  limitBounds,
  clampToLimit,
};
