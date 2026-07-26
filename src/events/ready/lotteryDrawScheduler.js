// 樂透開獎排程:每個玩法依 drawWeekdays / drawHour 各自排程。
// 啟動時補建當期 open draw,確保玩家可以買票。

require("colors");
const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const {
  runDraw,
  ensureNextDraw,
  recoverStuckDraw,
  settleStuckDrawInPlace,
} = require("../../features/casino/lottery/runDraw");
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
        // 先救援卡在 drawing 的期(開獎鎖期後被維修/重啟中斷)。啟動當下不會有真的在跑的開獎,
        // 這種 drawing 都是前一個 process 中斷留下的。已派過彩的期不自動重置,避免重複發錢。
        const rec = await recoverStuckDraw(client, t);
        if (rec.reason === "already_paid") {
          // 已派過彩 → 不重付,就地結算(重建自票券)並補公告。
          const s = await settleStuckDrawInPlace(client, t);
          if (s.ok) {
            console.log(
              `[LOTTERY] 就地結算已派彩但卡住的期 ${s.drawId}${s.numbersRecovered ? "" : "(號碼無法還原)"}`.green
            );
            if (s.numbersRecovered) {
              await announceDrawResult(client, { draw: s.draw, tickets: s.tickets }, { skipWinnerDm: true });
            }
          } else {
            console.log(
              `[LOTTERY] ⚠ ${rec.drawId} 已派彩但無法就地結算(${s.reason}),需人工處理(/lotteryadmin recover-draw)`.yellow
            );
          }
        } else if (rec.recovered) {
          console.log(`[LOTTERY] 救援卡住的開獎 ${rec.drawId}(重置為 open 待補開)`.green);
        }

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
