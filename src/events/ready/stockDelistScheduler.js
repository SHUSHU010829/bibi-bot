require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { stockSystem } = require("../../config");
const { runDailyScan } = require("../../features/stock/delistService");

module.exports = async (client) => {
  if (!stockSystem?.enabled) {
    console.log(`[STOCK-DELIST] 股市系統未啟用，跳過下市排程`.gray);
    return;
  }
  const cfg = stockSystem?.delisting;
  if (!cfg?.enabled) {
    console.log(`[STOCK-DELIST] 下市機制未啟用，跳過排程`.gray);
    return;
  }
  if (!client.stockMarketCollection) {
    console.log(`[STOCK-DELIST] DB 未連線，跳過下市排程`.yellow);
    return;
  }

  // 收盤後掃描：推進整理期 / 抽新觸發 / 冷卻期滿換新股補位
  registerCron(client, {
    name: "stock.delist",
    label: "股市下市掃描",
    schedule: cfg.scanCronSchedule || "5 21 * * *",
    timezone: stockSystem.timezone || "Asia/Taipei",
    runner: () => runDailyScan(client),
  });
};

module.exports.runDailyScan = runDailyScan;
