const { stockSystem } = require("../../config");
const treasuryService = require("./treasuryService");

function taxCfg() {
  return stockSystem?.tax || {};
}

function calcSellTax(proceeds) {
  const rate = taxCfg().sellTaxRate ?? 0;
  return Math.max(0, Math.floor((proceeds || 0) * rate));
}

function calcDayTradeTax(proceeds) {
  const rate = taxCfg().dayTradeTaxRate ?? 0;
  return Math.max(0, Math.floor((proceeds || 0) * rate));
}

function calcDividendTax(payout) {
  const rate = taxCfg().dividendTaxRate ?? 0;
  return Math.max(0, Math.floor((payout || 0) * rate));
}

// 玩家已被扣走全額 tax；其中 treasuryShare 記帳進國庫（其餘視為銷毀）。回傳實際入庫額。
async function routeToTreasury(client, guildId, taxAmount) {
  if (!(taxAmount > 0)) return 0;
  const cfg = stockSystem?.treasury;
  if (!cfg?.enabled) return 0;
  const share = cfg.treasuryShare ?? 0.5;
  const toTreasury = Math.floor(taxAmount * share);
  if (toTreasury > 0) {
    await treasuryService.addToTreasury(client, guildId, toTreasury).catch(() => {});
  }
  return toTreasury;
}

module.exports = {
  calcSellTax,
  calcDayTradeTax,
  calcDividendTax,
  routeToTreasury,
};
