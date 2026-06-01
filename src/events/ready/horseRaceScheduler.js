require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { casino } = require("../../config");
const {
  startRaceIfDue,
  abandonStaleRace,
} = require("../../features/casino/horseRacing/raceRunner");

// 賽馬定時排程：
//   1) status: betting 且 expiresAt 已過 → 觸發開賽（0 人下注就取消）
//   2) status: running 且超過 raceTtlSeconds 都沒結算 → 視為中斷退款
// 兩件事都有 atomic guard，重複觸發無害。

async function sweepOnce(client) {
  if (!client.horseRaceGamesCollection) return { started: 0, abandoned: 0 };
  const now = new Date();
  const cfg = casino?.horseRacing || {};
  const raceTtlMs = (cfg.raceTtlSeconds ?? 1800) * 1000;

  let started = 0;
  let abandoned = 0;

  // 售票期過期 → 開賽
  const dueCursor = client.horseRaceGamesCollection.find({
    status: "betting",
    expiresAt: { $lt: now },
  });
  while (await dueCursor.hasNext()) {
    const g = await dueCursor.next();
    await startRaceIfDue(client, g.gameId)
      .then(() => (started += 1))
      .catch((e) =>
        console.log(`[HORSE] sweep startRaceIfDue ${g.gameId} fail: ${e}`.yellow),
      );
  }

  // 卡住的 running → 退款
  const staleCursor = client.horseRaceGamesCollection.find({
    status: "running",
    updatedAt: { $lt: new Date(now.getTime() - raceTtlMs) },
  });
  while (await staleCursor.hasNext()) {
    const g = await staleCursor.next();
    await abandonStaleRace(client, g.gameId)
      .then(() => (abandoned += 1))
      .catch((e) =>
        console.log(`[HORSE] sweep abandon ${g.gameId} fail: ${e}`.yellow),
      );
  }

  return { started, abandoned };
}

module.exports = async (client) => {
  const cfg = casino?.horseRacing || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.horseRacing.sweep",
    label: "賽馬售票/中斷掃描",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
