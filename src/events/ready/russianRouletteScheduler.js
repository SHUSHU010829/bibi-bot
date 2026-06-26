require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { casino } = require("../../config");
const { startGame } = require("../../features/casino/russianRoulette/service");

// 俄羅斯輪盤到期掃描：waiting 且 expiresAt 已過 → 自動開轉（不足 2 人由 startGame 自動退款）。
// setTimeout 在開桌當下也會排一次，這裡兜底 bot 重啟 / 漏觸發。startGame 有 atomic guard。

async function sweepOnce(client) {
  if (!client.russianRouletteGamesCollection) return { started: 0 };
  const now = new Date();
  const cursor = client.russianRouletteGamesCollection.find({
    status: "waiting",
    expiresAt: { $lt: now },
  });

  let started = 0;
  while (await cursor.hasNext()) {
    const g = await cursor.next();
    await startGame(client, g.gameId)
      .then((r) => {
        if (r.ok) started += 1;
      })
      .catch((e) =>
        console.log(`[ROULETTE] sweep start ${g.gameId} fail: ${e}`.yellow)
      );
  }
  return { started };
}

module.exports = async (client) => {
  const cfg = casino?.russianRoulette || {};
  if (cfg.enabled === false) return;

  registerCron(client, {
    name: "casino.russianRoulette.sweep",
    label: "俄羅斯輪盤到期開轉掃描",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
