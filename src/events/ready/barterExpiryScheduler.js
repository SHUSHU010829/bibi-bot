require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const barterService = require("../../features/barter/barterService");

// 交易所（舊物物交換告示板）到期退款。交易所已整合進 /市集，此排程只負責把
// 存量的過期掛單退回託管物品（原先缺少 cron，過期掛單的託管物永遠不會自動退）。
// 待舊掛單清空後可移除本檔與整個 barter feature。

async function sweepOnce(client) {
  if (!client.barterListingsCollection) return { expired: 0 };
  try {
    const res = await barterService.sweepExpired(client);
    if (res?.expired) {
      console.log(`[BARTER] 交易所到期退款 ${res.expired} 筆`.gray);
    }
    return res || { expired: 0 };
  } catch (e) {
    console.log(`[ERROR] barter sweepExpired: ${e}`.red);
    return { expired: 0 };
  }
}

module.exports = async (client) => {
  registerCron(client, {
    name: "barter.expiry",
    label: "交易所掛單到期退款",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
