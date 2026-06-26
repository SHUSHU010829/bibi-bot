require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { notifyAbandon } = require("../../features/casino/notifyAbandon");

// 爬塔中途離場：expiresAt 過了還是 playing → 視玩家狀態退錢
//   - 還沒爬過任何一層：退回原始 bet
//   - 至少爬過 1 層：直接幫他 cash out（拿走累積派彩）

async function sweepOnce(client) {
  if (!client.towerGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.towerGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const floors = g.currentFloor || 0;
    const acc = g.accMultiplier || 1;
    const refund =
      floors > 0 ? Math.floor((g.bet || 0) * acc) : g.bet || 0;
    const resultTag = floors > 0 ? "abandoned_cashout" : "abandoned_refund";

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "tower",
          result: resultTag,
          gameId: g.gameId,
          bet: g.bet,
          floors,
          accMultiplier: acc,
        },
      });
    }

    await client.towerGamesCollection.updateOne(
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
      game: "tower",
      kind: floors > 0 ? "cashout" : "refund",
      amount: refund,
      detail: floors > 0 ? `爬到第 ${floors} 層・×${acc}` : null,
    });

    refunded += 1;
    console.log(
      `[TW] 退回未完成局 user=${g.userId} game=${g.gameId} floors=${floors} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.tower || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.tower.cleanup",
    label: "爬塔 放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
