require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { casino } = require("../../config");
const { closeRedPacket } = require("../../features/casino/redPacket/service");

// 搶紅包到期掃描：status:"open" 且 expiresAt 已過 → 關閉並退回未搶金額。
// setTimeout 也會在發包當下排一次，這裡是 bot 重啟 / 漏觸發的兜底。closeRedPacket 有 atomic guard。

async function sweepOnce(client) {
  if (!client.redPacketGamesCollection) return { closed: 0 };
  const now = new Date();
  const cursor = client.redPacketGamesCollection.find({
    status: "open",
    expiresAt: { $lt: now },
  });

  let closed = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    await closeRedPacket(client, g.gameId, { reason: "expired" })
      .then((r) => {
        if (r.closed) closed += 1;
      })
      .catch((e) =>
        console.log(`[REDPACKET] sweep close ${g.gameId} fail: ${e}`.yellow)
      );
  }
  return { closed };
}

module.exports = async (client) => {
  const cfg = casino?.redPacket || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.redPacket.sweep",
    label: "搶紅包到期退款掃描",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
