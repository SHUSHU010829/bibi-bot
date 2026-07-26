require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 一次性合併「已堆積的舊樂透票券」：把同一期、同一人、號碼與派彩結果完全相同的
 * 多筆 doc 合併成單一 doc + quantity，大幅降低文件數。
 *
 * 安全性：
 *   - 不刪任何「歷史」：合併後那張票仍在（只是用 quantity 記數量），花費 / 獎金 /
 *     購買張數等統計在讀取端都已改成 sum(quantity)，數字完全不變。
 *   - 只合併「所有結果欄位都相同」的 doc（同號碼同期 → matched / prize / 每張派彩
 *     本來就一樣），所以不會把不同結果的票混在一起。
 *   - 包牌（wheeling）各組合號碼不同 → 天然不會被合併。
 *   - idempotent：合併完每組只剩 1 筆，再跑一次不會有動作。
 *
 * 執行方式：
 *   node scripts/mergeLotteryTickets.js          # DRY RUN，只報告會省下多少（不動資料）
 *   node scripts/mergeLotteryTickets.js apply     # 實際執行合併
 */

const DB_NAME = "MorningBot";
const APPLY = process.argv.includes("apply");

// 兩筆 doc 要「完全等價」才合併：所有會被下游讀取的結果欄位都納入分組鍵。
function groupKeyFields() {
  return {
    userId: "$userId",
    guildId: "$guildId",
    lotteryType: "$lotteryType",
    numbers: "$numbers",
    special: "$special",
    source: "$source",
    subscriptionId: "$subscriptionId",
    wheelingId: "$wheelingId",
    matched: "$matched",
    prize: "$prize",
    payoutAmount: "$payoutAmount",
    bonusPayout: "$bonusPayout",
    specialMatched: "$specialMatched",
  };
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定，請先放到 .env".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(DB_NAME);
  const tickets = db.collection("LotteryTickets");

  console.log(
    APPLY
      ? "=== 合併模式（會實際修改資料）===".red
      : "=== DRY RUN（只報告，不動資料。加參數 apply 才執行）===".cyan,
  );

  let avgObj = 0;
  try {
    const s = await db.command({ collStats: "LotteryTickets" });
    avgObj = s.avgObjSize || 0;
    console.log(
      `目前 LotteryTickets：${s.count} 筆、儲存 ${fmtMB(s.storageSize || 0)}、索引 ${fmtMB(
        s.totalIndexSize || 0,
      )}、平均 ${Math.round(avgObj)} B/筆`,
    );
  } catch {
    // ignore
  }

  // 逐期處理以控制記憶體（drawId 數量 = 期數，遠小於票券數）
  const drawIds = await tickets.distinct("drawId");
  console.log(`共 ${drawIds.length} 期要掃描。\n`);

  let totalGroupsMerged = 0;
  let totalDocsRemoved = 0;
  let drawsAffected = 0;

  for (const drawId of drawIds) {
    const groups = await tickets
      .aggregate([
        { $match: { drawId } },
        {
          $group: {
            _id: groupKeyFields(),
            keepId: { $first: "$ticketId" },
            removeIds: { $push: "$ticketId" },
            qty: { $sum: { $ifNull: ["$quantity", 1] } },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    if (groups.length === 0) continue;
    drawsAffected += 1;

    const ops = [];
    for (const g of groups) {
      const removeIds = g.removeIds.filter((id) => id !== g.keepId);
      totalGroupsMerged += 1;
      totalDocsRemoved += removeIds.length;
      // 保留一筆，quantity 設為整組合計；其餘刪除
      ops.push({
        updateOne: {
          filter: { ticketId: g.keepId },
          update: { $set: { quantity: g.qty } },
        },
      });
      ops.push({
        deleteMany: { filter: { ticketId: { $in: removeIds } } },
      });
    }

    if (APPLY && ops.length > 0) {
      await tickets.bulkWrite(ops, { ordered: false });
      console.log(
        `  [${drawId}] 合併 ${groups.length} 組，移除 ${ops
          .filter((o) => o.deleteMany)
          .reduce((s, o) => s + o.deleteMany.filter.ticketId.$in.length, 0)} 筆`.gray,
      );
    }
  }

  console.log(`\n=== 結果 ===`.green);
  console.log(`受影響期數：${drawsAffected}`);
  console.log(`可合併群組：${totalGroupsMerged}`);
  console.log(`${APPLY ? "已移除" : "可移除"}文件數：${totalDocsRemoved}`);
  if (avgObj > 0) {
    console.log(
      `${APPLY ? "釋放" : "預估釋放"}資料量：約 ${fmtMB(totalDocsRemoved * avgObj)}（不含索引，實際會再多）`,
    );
  }
  if (!APPLY && totalDocsRemoved > 0) {
    console.log(`\n確認無誤後執行：`.yellow + ` node scripts/mergeLotteryTickets.js apply`);
  }
  if (APPLY) {
    console.log(
      `\n提示：WiredTiger 刪除後不會立刻歸還磁碟給 OS，空間會被同 collection 後續寫入重用；`.gray,
    );
    console.log(`若要立即回收可對該 collection 執行 compact（會短暫鎖表）。`.gray);
  }

  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[ERROR] ${e.stack || e.message}`.red);
  process.exit(1);
});
