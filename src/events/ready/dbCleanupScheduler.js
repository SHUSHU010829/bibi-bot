require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { dbMaintenance, casino } = require("../../config");

// 每日資料庫瘦身：處理「無法用純 TTL 索引清理」的終態資料。
//
// 為什麼不走 connectDb 的 TTL：
//   - BossEvents：時間欄位 settled_at 存的是 Date.now() 毫秒「數字」，Mongo TTL 只認
//     BSON Date，故改用 cron 依數字比對刪除。
//   - WantedList：同一 doc 由 wanted→終態就地轉移，active 與終態共用 updated_at 欄位，
//     純 TTL 會誤刪長期未更新的 active；用 status $in 過濾只清終態最安全。
//
// 已由 connectDb TTL 索引自動清理的（去重表 / 結束對局活動 / 統計三表 / 公會週任務…）不在這裡。

const DAY_MS = 24 * 60 * 60 * 1000;

// 刪除「已結算很久」的樂透票券明細：保留 draw 本身（開獎號碼 / 彩池 / 派彩摘要 =
// 精簡歷史），只清個別票券。config casino.lottery.ticketRetentionDays，設 0 / null 停用。
// open / drawing 期的票券永遠不動（只挑 status:"settled" 且開很久的期）。
async function cleanupLotteryTickets(client) {
  const retentionDays = casino?.lottery?.ticketRetentionDays || 0;
  if (
    retentionDays <= 0 ||
    !client.lotteryDrawsCollection ||
    !client.lotteryTicketsCollection
  ) {
    return 0;
  }

  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const cursor = client.lotteryDrawsCollection.find(
    { status: "settled", drawnAt: { $lt: cutoff } },
    { projection: { drawId: 1 } },
  );

  let removed = 0;
  for await (const draw of cursor) {
    const res = await client.lotteryTicketsCollection
      .deleteMany({ drawId: draw.drawId })
      .catch((e) => {
        console.log(
          `[DB-CLEANUP] LotteryTickets ${draw.drawId} 清理失敗：${e.message}`.red,
        );
        return { deletedCount: 0 };
      });
    removed += res.deletedCount || 0;
  }
  return removed;
}

async function cleanupOnce(client) {
  const result = { boss: 0, wanted: 0, lotteryTickets: 0 };

  // BOSS 終態（defeated / expired）：settled_at 為毫秒數字
  if (client.bossEventsCollection) {
    const cutoff = Date.now() - dbMaintenance.bossEventRetentionDays * DAY_MS;
    const res = await client.bossEventsCollection
      .deleteMany({
        status: { $in: ["defeated", "expired"] },
        settled_at: { $lt: cutoff },
      })
      .catch((e) => {
        console.log(`[DB-CLEANUP] BossEvents 清理失敗：${e.message}`.red);
        return { deletedCount: 0 };
      });
    result.boss = res.deletedCount || 0;
  }

  // 通緝榜終態（潛伏成功 / 被捕 / 自首 / 時效到期）：updated_at 為 Date
  if (client.wantedListCollection) {
    const cutoff = new Date(
      Date.now() - dbMaintenance.wantedTerminalRetentionDays * DAY_MS,
    );
    const res = await client.wantedListCollection
      .deleteMany({
        status: { $in: ["escaped", "caught", "surrendered", "expired"] },
        updated_at: { $lt: cutoff },
      })
      .catch((e) => {
        console.log(`[DB-CLEANUP] WantedList 清理失敗：${e.message}`.red);
        return { deletedCount: 0 };
      });
    result.wanted = res.deletedCount || 0;
  }

  // 已結算很久的樂透票券明細
  result.lotteryTickets = await cleanupLotteryTickets(client);

  if (result.boss || result.wanted || result.lotteryTickets) {
    console.log(
      `[DB-CLEANUP] 清理終態資料：BossEvents ${result.boss} 筆、WantedList ${result.wanted} 筆、樂透舊票 ${result.lotteryTickets} 筆`
        .cyan,
    );
  }
  return result;
}

module.exports = (client) => {
  registerCron(client, {
    name: "db.cleanup",
    label: "資料庫終態資料清理（BOSS / 通緝榜 / 樂透舊票）",
    schedule: "30 4 * * *",
    timezone: "Asia/Taipei",
    runner: () => cleanupOnce(client),
  });
};
