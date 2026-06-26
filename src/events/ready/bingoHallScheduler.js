require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const { casino } = require("../../config");
const {
  runDueDraws,
  ensureOpenRound,
} = require("../../features/casino/bingoHall/service");

// 賓果大廳排程：每分鐘掃 scheduledAt 到期的場次自動開球結算，並確保隨時有一場 open。
// 開獎、開新場都有 atomic guard，重複觸發無害。

async function tick(client) {
  await ensureOpenRound(client).catch((e) =>
    console.log(`[BINGOHALL] ensureOpenRound fail: ${e}`.yellow)
  );
  await runDueDraws(client).catch((e) =>
    console.log(`[BINGOHALL] runDueDraws fail: ${e}`.yellow)
  );
}

module.exports = async (client) => {
  const cfg = casino?.bingoHall || {};
  if (cfg.enabled === false) return;

  // 啟動時先確保有一場進行中
  ensureOpenRound(client).catch(() => {});

  registerCron(client, {
    name: "casino.bingoHall.tick",
    label: "賓果大廳開球掃描",
    schedule: "* * * * *",
    runner: () => tick(client),
  });
};
