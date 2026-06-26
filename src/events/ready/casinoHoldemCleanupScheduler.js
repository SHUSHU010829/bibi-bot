require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { notifyAbandon } = require("../../features/casino/notifyAbandon");

// 單人德州撲克中途離場：expiresAt 過了還是 playing（看完翻牌卻沒跟注/蓋牌）
// → 視為玩家還沒決定，退回底注 ante 並標記 abandoned。
// （已 settled 的不會被掃到；跟注後會立即結算，所以閒置局只會卡在底注階段。）

async function sweepOnce(client) {
  if (!client.casinoHoldemGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.casinoHoldemGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const refund = g.ante || 0;

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "casinoHoldem",
          result: "abandoned_refund",
          gameId: g.gameId,
          ante: g.ante,
        },
      });
    }

    const updated = await client.casinoHoldemGamesCollection.updateOne(
      { _id: g._id, status: "playing" },
      {
        $set: {
          status: "abandoned",
          result: "abandoned_refund",
          payout: refund,
          updatedAt: new Date(),
        },
      }
    );
    if (!updated.modifiedCount) continue; // 已被搶先處理

    if (refund > 0) {
      await notifyAbandon(client, g.userId, {
        game: "casinoHoldem",
        kind: "refund",
        amount: refund,
        detail: "底注",
      });
    }

    refunded += 1;
    console.log(
      `[CH] 退回未完成局 user=${g.userId} game=${g.gameId} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.casinoHoldem || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.casinoHoldem.cleanup",
    label: "德州撲克放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
