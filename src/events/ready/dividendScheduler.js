require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { stockSystem } = require("../../config");
const { payoutAll, announce, sendDmNotifications } = require("../../features/stock/dividendService");

async function listGuildIdsWithMarket(client) {
  if (!client.stockMarketCollection) return [];
  return client.stockMarketCollection.distinct("guildId", { enabled: { $ne: false } });
}

async function runPayout(client) {
  const guildIds = await listGuildIdsWithMarket(client);
  let totalPaid = 0;
  let totalRecipients = 0;
  for (const guildId of guildIds) {
    try {
      const summaries = await payoutAll(client, guildId);
      if (summaries.length === 0) {
        console.log(`[DIV] guild=${guildId} 本週無人受惠（沒有持股或殖利率全為 0）`.gray);
        continue;
      }
      const total = summaries.reduce((a, b) => a + b.totalPaid, 0);
      const hits = summaries.reduce((a, b) => a + b.recipients, 0);
      totalPaid += total;
      totalRecipients += hits;
      console.log(`[DIV] guild=${guildId} 本週配息完成：${total.toLocaleString()} credits, ${hits} 筆派息, ${summaries.length} 支股票`.cyan);
      await announce(client, guildId, summaries);
      await sendDmNotifications(client, summaries);
    } catch (e) {
      console.log(`[DIV] guild=${guildId} 配息失敗：${e?.stack || e?.message || e}`.red);
      throw e;
    }
  }
  return { guilds: guildIds.length, totalPaid, totalRecipients };
}

module.exports = async (client) => {
  if (!stockSystem?.enabled) {
    console.log(`[DIV] 股市系統未啟用，跳過配息排程`.gray);
    return;
  }
  const cfg = stockSystem?.dividend;
  if (!cfg?.enabled) {
    console.log(`[DIV] 配息未啟用，跳過排程`.gray);
    return;
  }
  if (!client.stockMarketCollection || !client.userPortfolioCollection) {
    console.log(`[DIV] DB 未連線，跳過配息排程`.yellow);
    return;
  }

  registerCron(client, {
    name: "stock.dividend",
    label: "股票每週配息",
    schedule: cfg.cronSchedule || "0 9 * * 1",
    timezone: cfg.timezone || stockSystem.timezone || "Asia/Taipei",
    runner: () => runPayout(client),
  });
};

module.exports.runPayout = runPayout;
