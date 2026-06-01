require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");

// 每分鐘掃 expiresAt 過期但 status 還是 playing 的局，
// 視為玩家中途跑掉 → 退回 bet（含 double 過的部分）並標記 abandoned。

async function sweepOnce(client) {
  if (!client.blackjackGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.blackjackGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    // 分牌局退所有手的注（含各手 doubled 額度）；非分牌局退單手
    const refund = Array.isArray(g.hands) && g.hands.length > 0
      ? g.hands.reduce((s, h) => s + (h.bet || 0) * (h.doubled ? 2 : 1), 0)
      : g.bet * (g.doubled ? 2 : 1);

    // 退錢：來源 payout 並標記 result=abandoned_refund，方便日後對帳
    await grantCoins(client, {
      userId: g.userId,
      guildId: g.guildId,
      username: g.username,
      amount: refund,
      source: "payout",
      meta: {
        game: "blackjack",
        result: "abandoned_refund",
        gameId: g.gameId,
        bet: g.bet,
        doubled: !!g.doubled,
        isSplit: !!g.isSplit,
      },
    });

    // 用 status 條件防 race（同時間 cron 跟 button 都不會雙退）
    await client.blackjackGamesCollection.updateOne(
      { _id: g._id, status: "playing" },
      {
        $set: {
          status: "abandoned",
          result: "refunded",
          payout: refund,
          updatedAt: new Date(),
        },
      }
    );

    refunded += 1;
    console.log(
      `[BJ] 退回未完成局 user=${g.userId} game=${g.gameId} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.blackjack || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.blackjack.cleanup",
    label: "21 點放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
