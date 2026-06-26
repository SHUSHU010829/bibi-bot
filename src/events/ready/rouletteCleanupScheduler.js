require('colors');

const { registerCron } = require('../../utils/cronRegistry');

const { casino } = require('../../config');
const grantCoins = require('../../features/economy/grantCoins');
const { notifyAbandon } = require('../../features/casino/notifyAbandon');

// 每分鐘掃 expiresAt 過期但 status 還是 'betting' 的局，
// 視為玩家放棄 → 全額退回 totalBudget 並標記 abandoned。

async function sweepOnce(client) {
  if (!client.rouletteGamesCollection) return { refunded: 0 };

  const now = new Date();
  const cursor = client.rouletteGamesCollection.find({
    status: 'betting',
    expiresAt: { $lt: now },
  });

  let refunded = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();

    // 用 status 條件防 race（玩家按取消 & cron 同時跑）
    const updated = await client.rouletteGamesCollection.findOneAndUpdate(
      { _id: g._id, status: 'betting' },
      {
        $set: {
          status: 'abandoned',
          result: null,
          payout: g.totalBudget,
          updatedAt: new Date(),
        },
      }
    );
    if (!updated) continue; // 已被搶先處理，跳過

    await grantCoins(client, {
      userId: g.userId,
      guildId: g.guildId,
      username: g.username,
      amount: g.totalBudget,
      source: 'payout',
      meta: {
        game: 'roulette',
        reason: 'timeout',
        gameId: g.gameId,
        totalBudget: g.totalBudget,
      },
    });

    await notifyAbandon(client, g.userId, {
      game: "roulette",
      kind: "refund",
      amount: g.totalBudget,
    });

    refunded += 1;
    console.log(
      `[ROULETTE] 退回逾時局 user=${g.userId} game=${g.gameId} refund=${g.totalBudget}`.gray
    );
  }
  return { refunded };
}

module.exports = async (client) => {
  const cfg = casino?.roulette || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: 'casino.roulette.cleanup',
    label: '輪盤放棄局清理',
    schedule: '* * * * *',
    runner: () => sweepOnce(client),
  });
};
