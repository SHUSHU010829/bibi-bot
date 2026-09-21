// 擊殺後的收尾：結算 → 發獎 → 公告。玩家攻擊與管理指令共用同一條路徑，
// 兩邊各寫一份的話其中一份遲早會漏發獎或漏公告。
const bossEngine = require("./bossEngine");
const bossRewards = require("./bossRewards");
const bossAnnouncer = require("./bossAnnouncer");

async function settleAndAnnounce(client, guild, bossId) {
  const bossDoc = await client.bossEventsCollection.findOne({ boss_id: bossId });
  if (!bossDoc || bossDoc.settled_at) return null;
  const settlement = await bossEngine.settleBoss(client, bossDoc);
  if (!settlement) return null;
  await bossRewards.distribute(client, guild, settlement);
  await bossAnnouncer.announceSettlement(client, settlement);
  return settlement;
}

module.exports = { settleAndAnnounce };
