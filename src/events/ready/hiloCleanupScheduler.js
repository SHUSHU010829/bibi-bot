require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { notifyAbandon } = require("../../features/casino/notifyAbandon");

// HI-LO 中途離場：expiresAt 過了還是 playing → 視玩家狀態退錢
//   - 還沒贏過任何一把：退回原始 bet
//   - 至少贏過 1 把：直接幫他 cash out（拿走累積派彩）

async function sweepOnce(client) {
  if (!client.hiloGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.hiloGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const wins = g.wins || 0;
    const acc = g.accMultiplier || 1;
    const refund =
      wins > 0 ? Math.floor((g.bet || 0) * acc) : g.bet || 0;
    const resultTag = wins > 0 ? "abandoned_cashout" : "abandoned_refund";

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "hilo",
          result: resultTag,
          gameId: g.gameId,
          bet: g.bet,
          wins,
          accMultiplier: acc,
        },
      });
    }

    await client.hiloGamesCollection.updateOne(
      { _id: g._id, status: "playing" },
      {
        $set: {
          status: "abandoned",
          result: resultTag,
          payout: refund,
          updatedAt: new Date(),
        },
      }
    );

    await notifyAbandon(client, g.userId, {
      game: "hilo",
      kind: wins > 0 ? "cashout" : "refund",
      amount: refund,
      detail: wins > 0 ? `連贏 ${wins} 把・×${acc}` : null,
    });

    refunded += 1;
    console.log(
      `[HL] 退回未完成局 user=${g.userId} game=${g.gameId} wins=${wins} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.hilo || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.hilo.cleanup",
    label: "HI-LO 放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
