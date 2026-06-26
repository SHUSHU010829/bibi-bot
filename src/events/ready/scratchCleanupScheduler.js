require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { notifyAbandon } = require("../../features/casino/notifyAbandon");

// 刮刮樂中途離場：expiresAt 過了還是 playing → 直接按既定結果結算。
// 卡的中獎與否在買卡當下就抽定了，沒刮完不影響結果：中獎照付、槓龜歸零。

async function sweepOnce(client) {
  if (!client.scratchGamesCollection) return { settled: 0 };

  const now = new Date();
  const cursor = client.scratchGamesCollection.find({
    status: "playing",
    expiresAt: { $lt: now },
  });

  let settled = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    const win = (g.multiplier || 0) > 0;
    const payout = win ? Math.floor((g.bet || 0) * g.multiplier + 1e-9) : 0;

    if (payout > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: payout,
        source: "payout",
        meta: {
          game: "scratch",
          result: "abandoned_settle",
          gameId: g.gameId,
          bet: g.bet,
          multiplier: g.multiplier,
        },
      });
    }

    await client.scratchGamesCollection.updateOne(
      { _id: g._id, status: "playing" },
      {
        $set: {
          status: "settled",
          result: win ? "win" : "lose",
          revealed: [0, 1, 2, 3, 4, 5, 6, 7, 8],
          payout,
          updatedAt: new Date(),
        },
      }
    );

    await notifyAbandon(client, g.userId, {
      game: "scratch",
      kind: win ? "win" : "lose",
      amount: payout,
    });

    settled += 1;
    console.log(
      `[SC] 結算未刮完卡 user=${g.userId} game=${g.gameId} win=${win} payout=${payout}`.gray
    );
  }
  return { settled };
}

module.exports = async (client) => {
  const cfg = casino?.scratch || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.scratch.cleanup",
    label: "刮刮樂 放棄卡結算",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
