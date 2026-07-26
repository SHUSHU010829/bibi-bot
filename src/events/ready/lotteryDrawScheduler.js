// 樂透開獎排程:每個玩法依 drawWeekdays / drawHour 各自排程。
// 啟動時補建當期 open draw,確保玩家可以買票。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const { runDraw, ensureNextDraw } = require("../../features/casino/lottery/runDraw");
const { announceDrawResult } = require("../../features/casino/lottery/announceResult");
const { listLotteryTypes } = require("../../features/casino/lottery/numbers");
const { buildDrawCron } = require("../../features/casino/lottery/schedule");

async function runOneDraw(client, lotteryType) {
  const result = await runDraw(client, lotteryType);
  if (result) {
    await announceDrawResult(client, result);
  }
  return { lotteryType, drawn: !!result };
}

module.exports = (client) => {
  const cfg = casino?.lottery;
  if (!cfg?.enabled) return;

  const tz = cfg.timezone || "Asia/Taipei";

  // 啟動時:先補開維修/離線期間錯過的開獎,再補建當期(每個玩法都要有 open 期才能買票)。
  setTimeout(async () => {
    for (const t of listLotteryTypes()) {
      const typeCfg = cfg.types?.[t];
      if (!typeCfg?.enabled) continue;
      try {
        // runDraw 只鎖 scheduledAt <= now 的 open 期:當期開獎時間未到 → 回傳 null 不動作;
        // 維修期間 cron 沒觸發、當期開獎時間已過 → 這裡補開並公告(補完會自動開下一期)。
        const missed = await runDraw(client, t);
        if (missed) {
          console.log(`[LOTTERY] 補開維修期間錯過的開獎 ${missed.draw.drawId}`.green);
          await announceDrawResult(client, missed);
        }
        await ensureNextDraw(client, t);
      } catch (err) {
        console.log(`[LOTTERY] 啟動補開/補建期數 [${t}] 失敗:${err}`.red);
      }
    }
  }, 5000);

  for (const t of listLotteryTypes()) {
    const typeCfg = cfg.types?.[t];
    if (!typeCfg?.enabled) continue;
    const drawCron = buildDrawCron(t);

    registerCron(client, {
      name: `lottery.draw.${t}`,
      label: `樂透開獎 [${t}]`,
      schedule: drawCron,
      timezone: tz,
      runner: () => runOneDraw(client, t),
    });
  }
};
