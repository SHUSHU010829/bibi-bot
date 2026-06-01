require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");

// 射龍門中途離場：expiresAt 過了還在 awaitingChoice → 退回入場費 ante。
// 玩家根本還沒決定要不要補，視為不該被罰；ante 全額退還。
// （已進入 settled 的不會被掃到。）

async function sweepOnce(client) {
  if (!client.dragonGateGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.dragonGateGamesCollection.find({
    status: { $in: ["awaitingChoice", "playing"] },
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const refund = g.ante || 0;
    const resultTag = "abandoned_refund";

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "dragonGate",
          result: resultTag,
          gameId: g.gameId,
          ante: g.ante,
          bet: g.bet,
          lock: g.lock,
        },
      });
    }

    await client.dragonGateGamesCollection.updateOne(
      { _id: g._id, status: { $in: ["awaitingChoice", "playing"] } },
      {
        $set: {
          status: "abandoned",
          result: resultTag,
          payout: refund,
          updatedAt: new Date(),
        },
      }
    );

    refunded += 1;
    console.log(
      `[DG] 退回未完成局 user=${g.userId} game=${g.gameId} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.dragonGate || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.dragonGate.cleanup",
    label: "射龍門放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
