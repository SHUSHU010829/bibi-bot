require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const {
  closeTable,
  autoActOnTimeout,
  postThreadAnnouncement,
} = require("../../features/casino/poker/service");

async function sweepTables(client) {
  if (!client.pokerGamesCollection) return { closed: 0 };
  const now = new Date();
  const cursor = client.pokerGamesCollection.find({
    status: { $in: ["waiting", "playing", "settled"] },
    expiresAt: { $lt: now },
  });
  let closed = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    console.log(
      `[POKER] 牌桌逾時 gameId=${doc.gameId} status=${doc.status} thread=${doc.threadId}`.gray
    );
    try {
      await closeTable(client, doc, { reason: "abandoned_timeout" });
      closed += 1;
    } catch (e) {
      console.log(`[POKER] closeTable 失敗 gameId=${doc.gameId}: ${e.message}`.red);
    }
  }
  return { closed };
}

async function sweepActions(client) {
  if (!client.pokerGamesCollection) return { warned: 0, autoActed: 0 };
  const now = new Date();

  // 1) 倒數剩 ≤15 秒 → 發提醒（每位玩家每回合只發一次）
  const warnAt = new Date(now.getTime() + 15 * 1000);
  const warnCursor = client.pokerGamesCollection.find({
    status: "playing",
    actionWarningFired: { $ne: true },
    actionDeadline: { $lt: warnAt, $gt: now },
  });
  let warned = 0;
  while (await warnCursor.hasNext()) {
    const doc = await warnCursor.next();
    try {
      const actor = doc.players[doc.toActIdx];
      if (actor) {
        const ts = doc.actionDeadline
          ? Math.floor(new Date(doc.actionDeadline).getTime() / 1000)
          : null;
        await postThreadAnnouncement(
          client,
          doc,
          `⏰ <@${actor.userId}> **剩 15 秒**${ts ? ` ・ <t:${ts}:R> 過期` : ""}\n-# 不動就會自動處理（沒人下注 → 過牌；有人下注 → 棄牌）`,
          [actor.userId]
        );
      }
      await client.pokerGamesCollection.updateOne(
        { _id: doc._id },
        { $set: { actionWarningFired: true } }
      );
      warned += 1;
    } catch (e) {
      console.log(`[POKER] 倒數提醒失敗 gameId=${doc.gameId}: ${e.message}`.red);
    }
  }

  // 2) 已過期 → auto-fold/check
  const cursor = client.pokerGamesCollection.find({
    status: "playing",
    actionDeadline: { $lt: now, $ne: null },
  });
  let autoActed = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    try {
      await autoActOnTimeout(client, doc);
      autoActed += 1;
    } catch (e) {
      console.log(`[POKER] auto-fold 失敗 gameId=${doc.gameId}: ${e.message}`.red);
    }
  }
  return { warned, autoActed };
}

module.exports = async (client) => {
  const cfg = casino?.poker || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.poker.tableSweep",
    label: "撲克牌桌逾時清理",
    schedule: "* * * * *",
    runner: () => sweepTables(client),
  });

  // 每 10 秒掃一次行動倒數，逾時自動 fold/check
  registerCron(client, {
    name: "casino.poker.actionSweep",
    label: "撲克行動倒數掃描",
    schedule: "*/10 * * * * *",
    runner: () => sweepActions(client),
  });
};
