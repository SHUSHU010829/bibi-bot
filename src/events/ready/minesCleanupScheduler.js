require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");

// 踩地雷中途離場：expiresAt 過了還是 playing → 視玩家狀態退錢
//   - 還沒翻過任何一格：退回原始 bet
//   - 至少翻過 1 格：直接幫他 cash out（拿走當前派彩）

async function sweepOnce(client) {
  if (!client.minesGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.minesGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const revealed = (g.revealed || []).length;
    const mult = g.multiplier || 1;
    const refund =
      revealed > 0 ? Math.floor((g.bet || 0) * mult) : g.bet || 0;
    const resultTag = revealed > 0 ? "abandoned_cashout" : "abandoned_refund";

    if (refund > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: refund,
        source: "payout",
        meta: {
          game: "mines",
          result: resultTag,
          gameId: g.gameId,
          bet: g.bet,
          revealed,
          multiplier: mult,
        },
      });
    }

    await client.minesGamesCollection.updateOne(
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

    // 主動 DM 通知，避免玩家以為被清房後錢不見了
    try {
      const user = await client.users.fetch(g.userId).catch(() => null);
      if (user) {
        const body =
          revealed > 0
            ? `🧹 你的 **踩地雷** 因閒置太久自動收手了（翻了 ${revealed} 格・×${mult}）。\n` +
              `已派彩 **${refund.toLocaleString()}** credits 入帳。`
            : `🧹 你的 **踩地雷** 因閒置太久自動結束了（一格都還沒翻）。\n` +
              `已全額退回 **${refund.toLocaleString()}** credits。`;
        await user
          .send(`${body}\n-# 系統每分鐘清理閒置超過 5 分鐘的牌局，錢一定會回到你身上 👍`)
          .catch(() => {});
      }
    } catch (err) {
      console.log(`[MN] 清房 DM 失敗 ${g.userId}:${err.message}`.yellow);
    }

    refunded += 1;
    console.log(
      `[MN] 退回未完成局 user=${g.userId} game=${g.gameId} revealed=${revealed} refund=${refund}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.mines || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.mines.cleanup",
    label: "踩地雷 放棄局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
