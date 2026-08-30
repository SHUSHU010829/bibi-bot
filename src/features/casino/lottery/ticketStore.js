// 樂透票券寫入層：所有「買票」路徑（購買 / 訂閱自動買）共用。
//
// 持有方式：同一期、同一人、同一組號碼的票聚合成單一 doc + quantity。
// 再買一次同組號碼只是 $inc quantity，不會多一筆文件——持有張數再多，文件數的上限
// 都只跟「這個人在這期買過幾組不同號碼」有關（小樂透最多 C(20,3)=1140 組）。
//
// 合併鍵刻意含 source / subscriptionId / wheelingId / pricePaid：訂閱統計、包牌彙總、
// 花費統計都以這些欄位分群，混在一起會算錯。
// 號碼本身用 comboKey（純量）當鍵而不是直接比對 numbers 陣列，這樣合併鍵全是純量欄位，
// 可以走一般 index，也不必依賴 upsert 從陣列 equality 反推新文件內容。

const crypto = require("crypto");

function buildComboKey(numbers, special) {
  return `${numbers.join("-")}#${special ?? ""}`;
}

/**
 * 寫入一批票券（會與同期同號碼的既有票券合併）。
 * @param {object} params
 * @param {Array<{numbers:number[], special?:number|null, quantity:number}>} params.entries
 * @returns {Promise<{ ticketIds: string[], docs: number, quantity: number }>}
 *   ticketIds 只含「這次真的新建」的票券 id；合併進既有 doc 的不會有新 id。
 */
async function addTickets(client, {
  drawId,
  lotteryType,
  userId,
  guildId,
  username,
  entries,
  pricePaid,
  source,
  subscriptionId = null,
  wheelingId = null,
}) {
  const now = new Date();
  const candidates = entries.map((e) => ({
    ticketId: crypto.randomUUID(),
    numbers: [...e.numbers],
    special: e.special ?? null,
    quantity: e.quantity,
  }));

  const ops = candidates.map((c) => ({
    updateOne: {
      filter: {
        drawId,
        userId,
        guildId,
        comboKey: buildComboKey(c.numbers, c.special),
        source,
        subscriptionId,
        wheelingId,
        pricePaid,
      },
      update: {
        $inc: { quantity: c.quantity },
        $setOnInsert: {
          ticketId: c.ticketId,
          lotteryType,
          numbers: c.numbers,
          special: c.special,
          matched: 0,
          specialMatched: false,
          prize: null,
          payoutAmount: 0,
          bonusPayout: 0,
          createdAt: now,
        },
        $set: { username, updatedAt: now },
      },
      upsert: true,
    },
  }));

  const res = await client.lotteryTicketsCollection.bulkWrite(ops, {
    ordered: false,
  });

  const inserted = new Set(Object.keys(res.upsertedIds || {}).map(Number));
  return {
    ticketIds: candidates.filter((_, i) => inserted.has(i)).map((c) => c.ticketId),
    docs: candidates.length,
    quantity: candidates.reduce((s, c) => s + c.quantity, 0),
  };
}

module.exports = { addTickets, buildComboKey };
