require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");

// 尋寶（Keno）中途離場：expiresAt 過了還是 selecting → 退回本金。

async function sweepOnce(client) {
  if (!client.kenoGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.kenoGamesCollection.find({
    status: "selecting",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const refund = g.bet || 0;

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "keno",
          result: "abandoned_refund",
          gameId: g.gameId,
          bet: g.bet,
        },
      });
    }

    await client.kenoGamesCollection.updateOne(
      { _id: g._id, status: "selecting" },
      {
        $set: {
          status: "abandoned",
          result: "abandoned_refund",
          payout: refund,
          updatedAt: new Date(),
        },
      }
    );

    refunded += 1;
    console.log(
      `[KENO] 退回未完成局 user=${g.userId} game=${g.gameId} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.keno || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.keno.cleanup",
    label: "尋寶放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
