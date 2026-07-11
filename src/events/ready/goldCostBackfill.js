require("colors");

const { bank } = require("../../config");
const goldService = require("../../features/bank/goldService");

// 一次性回填舊金庫成本基準。
//
// 平均成本是這次才新增的功能，改動前就持有的黃金沒有 costBasis 欄位。若不回填，
// 舊持有者改動後第一次買進時 `$inc costBasis` 只會累加新買的部分、卻除以全部持有量，
// 均價會被算成超低、顯示假獲利。故在開機（connectDb 之後、玩家交易之前）先把舊資料
// 的成本設為「持有量 × 今日賣出價」＝今天損益歸零，之後才在此基準上累積真實成本。
//
// idempotent：只補「沒有 costBasis」的 doc；交易過（已有 costBasis）的不動，重開機不重跑。
module.exports = async (client) => {
  if (!bank?.gold?.enabled) return;
  const col = client.goldHoldingsCollection;
  if (!col) return;

  const missing = await col.countDocuments({ costBasis: { $exists: false } }).catch(() => null);
  if (!missing) return;

  const prices = await goldService.getPrices();
  const sell = prices.sell;

  try {
    const filled = await col.updateMany(
      { costBasis: { $exists: false }, units: { $gt: 0 } },
      [
        {
          $set: {
            costBasis: { $round: [{ $multiply: ["$units", sell] }, 0] },
            costBackfilledAt: "$$NOW",
          },
        },
      ],
    );
    // 已賣光但殘留的 doc：成本歸零，避免下次仍被視為待回填。
    await col.updateMany(
      { costBasis: { $exists: false } },
      { $set: { costBasis: 0, costBackfilledAt: new Date() } },
    );
    console.log(
      `[GOLD] 回填舊金庫成本基準 ${filled.modifiedCount} 筆（以今日賣出價 ${sell}/${bank.gold.unitLabel || "克"}）`.green,
    );
  } catch (e) {
    console.log(`[GOLD] 金庫成本回填失敗：${e?.message || e}`.yellow);
  }
};
