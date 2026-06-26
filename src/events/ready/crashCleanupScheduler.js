require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { notifyAbandon } = require("../../features/casino/notifyAbandon");
const { settleRetroactive } = require("../../features/casino/crash/engine");
const { buildSettledPayload } = require("../../features/casino/crash/renderer");

// 重啟 / 異常後沒被 tick 收尾的局：bustAt 過了還 playing → 回放邏輯結算
//   有 autocashout 且 autocashoutAt < bustAt → 視為自動收手成功 → 補派彩
//   否則 → 視為爆炸，bet 已扣不退
//
// 同時補上訊息 edit（拿得到 channelId / messageId 才嘗試）。

async function tryEditFinal(client, doc) {
  if (!doc.channelId || !doc.messageId) return;
  try {
    const channel = await client.channels.fetch(doc.channelId);
    if (!channel) return;
    const msg = await channel.messages.fetch(doc.messageId);
    if (!msg) return;
    const after = await client.userCoinsCollection.findOne({
      userId: doc.userId,
      guildId: doc.guildId,
    });
    const balance = after?.totalCoins || 0;
    const payload = await buildSettledPayload(
      {
        ...doc,
        startedAt: +doc.startedAt,
        bustAt: +doc.bustAt,
      },
      { username: doc.username, balance },
    );
    await msg.edit(payload);
  } catch (e) {
    console.log(
      `[CR] cleanup edit msg failed game=${doc.gameId}: ${e.message}`.gray,
    );
  }
}

async function sweepOnce(client) {
  if (!client.crashGamesCollection) return { recovered: 0 };

  const now = new Date();
  const cursor = client.crashGamesCollection.find({
    status: "playing",
    bustAt: { $lt: now },
  });

  let recovered = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();

    // 把 Date 轉回 epoch ms 給 engine
    const stateForEngine = {
      ...g,
      startedAt: +g.startedAt,
      bustAt: +g.bustAt,
      autocashoutAt: g.autocashoutAt != null ? +g.autocashoutAt : null,
    };
    const settled = settleRetroactive(stateForEngine);

    // atomic CAS
    const result = await client.crashGamesCollection.findOneAndUpdate(
      { _id: g._id, status: "playing" },
      {
        $set: {
          status: "settled",
          result: settled.result,
          cashoutAt: settled.cashoutAt,
          payout: settled.payout,
          recovered: true,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    const finalDoc = result?.value ?? result;
    if (!finalDoc || finalDoc.status !== "settled") continue;

    if (settled.payout > 0) {
      await grantCoins(client, {
        userId: g.userId,
        guildId: g.guildId,
        username: g.username,
        amount: settled.payout,
        source: "payout",
        meta: {
          game: "crash",
          result: settled.result,
          gameId: g.gameId,
          bet: g.bet,
          autocashout: g.autocashout,
          cashoutAt: settled.cashoutAt,
          bust: g.bust,
          recovered: true,
        },
      });
    }

    await tryEditFinal(client, finalDoc);

    await notifyAbandon(client, g.userId, {
      game: "crash",
      kind: settled.payout > 0 ? "cashout" : "bust",
      amount: settled.payout,
      detail:
        settled.payout > 0 && settled.cashoutAt
          ? `自動收手 ×${settled.cashoutAt}`
          : null,
    });

    recovered += 1;
    console.log(
      `[CR] 修復未完成局 user=${g.userId} game=${g.gameId} result=${settled.result} payout=${settled.payout}`.gray,
    );
  }
  return { recovered };
}

module.exports = async (client) => {
  const cfg = casino?.crash || {};
  if (cfg.enabled === false) return;

  // 啟動時先掃一次，把重啟前留下的局收尾
  sweepOnce(client).catch((err) => {
    console.log(`[CR] 初次清理失敗：${err.message}`.yellow);
  });

  registerCron(client, {
    name: "casino.crash.cleanup",
    label: "火箭遺失局清理",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
