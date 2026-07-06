const { DateTime } = require("luxon");
const { stockSystem } = require("../../config");
const { MONEY_EMOJI } = require("../../constants/coin");
const grantCoins = require("../economy/grantCoins");

const GRADE_LABEL = { normal: "一般線報", premium: "高級內線" };
const GRADE_FLAVOR = {
  normal: "消息來源：街頭巷議，真假參半",
  premium: "消息來源：內部管道，可信度較高",
};

function insiderCfg() {
  return stockSystem?.insider || {};
}

function gradeLabel(grade) {
  return GRADE_LABEL[grade] || grade;
}

async function pickTarget(client, guildId, symbol) {
  if (symbol) {
    const m = await client.stockMarketCollection.findOne({ guildId, symbol });
    if (!m || m.enabled === false) return null;
    return m;
  }
  const stocks = await client.stockMarketCollection
    .find({ guildId, enabled: { $ne: false } })
    .toArray();
  if (!stocks.length) return null;
  return stocks[Math.floor(Math.random() * stocks.length)];
}

// 真情報方向 = 動能符號優先；動能接近 0 時看與合理價的偏離（低於合理價偏反彈）。
function realDirectionUp(market) {
  const mom = market.momentum || 0;
  if (Math.abs(mom) > 1e-6) return mom > 0;
  const fair = market.fairValue || market.currentPrice;
  const dev = fair > 0 ? (market.currentPrice - fair) / fair : 0;
  return dev < 0;
}

async function buyTip(client, { userId, guildId, username, member, symbol, grade }) {
  const cfg = insiderCfg();
  if (!cfg.enabled) {
    return { ok: false, reason: "disabled", message: "🔒 內線情報暫未開放。" };
  }
  const gradeCfg = cfg.grades?.[grade];
  if (!gradeCfg) {
    return { ok: false, reason: "bad_grade", message: "❌ 未知的情報等級。" };
  }

  const tz = stockSystem?.timezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();
  const startOfDay = DateTime.fromISO(today, { zone: tz }).toJSDate();
  const usedToday = await client.stockInsiderTipsCollection
    .countDocuments({ userId, guildId, createdAt: { $gte: startOfDay } })
    .catch(() => 0);
  const dailyLimit = cfg.dailyLimit ?? 5;
  if (usedToday >= dailyLimit) {
    return {
      ok: false,
      reason: "daily_limit",
      message: `🕵️ 今日情報已達上限（${dailyLimit} 則），明天再來探聽。`,
    };
  }

  const market = await pickTarget(client, guildId, symbol);
  if (!market) {
    return {
      ok: false,
      reason: "no_symbol",
      message: symbol ? `❌ 找不到股票代號 \`${symbol}\`。` : "❌ 目前沒有可探聽的股票。",
    };
  }

  const cost = gradeCfg.cost;
  const userCoins = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = userCoins?.totalCoins || 0;
  if (balance < cost) {
    return {
      ok: false,
      reason: "insufficient_balance",
      message: `${MONEY_EMOJI} 餘額不足！${gradeLabel(grade)}需要 **${cost.toLocaleString()}** credits，目前 ${balance.toLocaleString()}。`,
    };
  }

  const paid = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -cost,
    source: "stock_insider_fee",
    member,
    meta: { symbol: market.symbol, grade },
  });
  if (!paid) {
    return { ok: false, reason: "grant_failed", message: "❌ 扣款失敗，請稍後再試。" };
  }

  const isFake = Math.random() < (gradeCfg.fakeChance ?? 0);
  const realUp = realDirectionUp(market);
  const up = isFake ? !realUp : realUp;

  const expiresAt = new Date(Date.now() + (cfg.tipTtlMinutes ?? 120) * 60 * 1000);
  await client.stockInsiderTipsCollection
    .insertOne({
      userId,
      guildId,
      symbol: market.symbol,
      grade,
      direction: up ? "up" : "down",
      isFake,
      priceAtTip: market.currentPrice,
      momentum: market.momentum || 0,
      resolved: false,
      createdAt: new Date(),
      expiresAt,
    })
    .catch(() => {});

  return {
    ok: true,
    symbol: market.symbol,
    name: market.name,
    grade,
    gradeLabel: gradeLabel(grade),
    flavor: GRADE_FLAVOR[grade] || "",
    cost,
    up,
    price: market.currentPrice,
    remaining: dailyLimit - usedToday - 1,
    balanceAfter: balance - cost,
  };
}

module.exports = { buyTip, gradeLabel };
