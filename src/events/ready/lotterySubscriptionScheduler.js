// 樂透訂閱扣款排程:每個玩法在自己開獎前 30 分鐘各自觸發。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const { processAllSubscriptions } = require("../../features/casino/lottery/subscriptions");
const { listLotteryTypes } = require("../../features/casino/lottery/numbers");
const { buildSubscriptionCron } = require("../../features/casino/lottery/schedule");

module.exports = (client) => {
  const cfg = casino?.lottery;
  if (!cfg?.enabled) return;

  const tz = cfg.timezone || "Asia/Taipei";

  for (const t of listLotteryTypes()) {
    const typeCfg = cfg.types?.[t];
    if (!typeCfg?.enabled) continue;

    registerCron(client, {
      name: `lottery.subscription.${t}`,
      label: `樂透訂閱扣款 [${t}]`,
      schedule: buildSubscriptionCron(t),
      timezone: tz,
      runner: () => processAllSubscriptions(client, { lotteryType: t }),
    });
  }
};
