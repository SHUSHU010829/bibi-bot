// 火箭 in-process tick 管理器：每局一支 setInterval，
// 負責定時 edit 訊息 + 偵測 bust / autocashout 觸發時機。
//
// 不靠 setInterval 來「派彩」也能跑（重啟後 cleanupScheduler 會接手），
// 這支只是讓玩家在 bot 線上時看到倍率動。

const grantCoins = require("../../economy/grantCoins");
const { casino } = require("../../../config");
const reminder = require("../../reminders/cooldownReminderService");
const {
  multiplierAt,
  settleCrashed,
  settleAutoCashout,
} = require("./engine");
const {
  buildPlayingPayload,
  buildSettledPayload,
} = require("./renderer");

const TICK_MS = 2_000;

// gameId → { intervalId }
const tickers = new Map();

function stop(gameId) {
  const t = tickers.get(gameId);
  if (!t) return;
  clearInterval(t.intervalId);
  // 起飛那一刻的一次性 edit 還沒觸發就結束（例如提早被結算），一併清掉
  if (t.launchTimeout) clearTimeout(t.launchTimeout);
  tickers.delete(gameId);
}

function isRunning(gameId) {
  return tickers.has(gameId);
}

async function editMessage(client, { channelId, messageId }, payload) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const msg = await channel.messages.fetch(messageId);
    if (!msg) return;
    await msg.edit(payload);
  } catch (e) {
    console.log(
      `[crash tick] edit failed channel=${channelId} msg=${messageId} err=${e.message}`,
    );
  }
}

// 嘗試 atomic CAS：把 playing 局推到 settled 並寫入結算欄位。
// 回傳：成功 → 更新後的 doc；失敗（已被別條路徑搶先結算）→ null
async function tryCommitSettled(client, gameId, settled) {
  const now = new Date();
  const result = await client.crashGamesCollection.findOneAndUpdate(
    { gameId, status: "playing" },
    {
      $set: {
        status: "settled",
        result: settled.result,
        cashoutAt: settled.cashoutAt,
        payout: settled.payout,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  // 不同版本的 driver 回傳形式不一致，兼容處理
  const doc = result?.value ?? result;
  if (!doc || doc.status !== "settled") return null;

  // 火箭落地 → 進入補燃料冷卻。若玩家有訂閱「火箭到點通知」，把冷卻結束時間更新到
  // 最新一局，讓 cron 在冷卻結束時 DM 提醒（沒訂閱者不會被建立，故不影響其他人）。
  const cooldownSec = casino?.crash?.cooldownSeconds ?? 0;
  if (cooldownSec > 0 && doc.userId && doc.guildId) {
    reminder
      .refreshIfEnabled(client, {
        userId: doc.userId,
        guildId: doc.guildId,
        type: "crash",
        readyAt: now.getTime() + cooldownSec * 1000,
      })
      .catch(() => {});
  }

  return doc;
}

// 結算為 cashout 並派彩。
async function commitCashout(client, state, settled) {
  const committed = await tryCommitSettled(client, state.gameId, settled);
  if (!committed) return null;

  const payoutResult = await grantCoins(client, {
    userId: state.userId,
    guildId: state.guildId,
    username: state.username,
    amount: settled.payout,
    source: "payout",
    meta: {
      game: "crash",
      result: settled.result,
      gameId: state.gameId,
      bet: settled.bet,
      autocashout: settled.autocashout,
      cashoutAt: settled.cashoutAt,
      bust: settled.bust,
      auto: settled.result === "cashout" && settled.cashoutAt === settled.autocashout,
    },
  });
  const balanceAfter = payoutResult?.doc?.totalCoins;
  return { committed, balanceAfter };
}

async function commitCrashed(client, state) {
  const settled = settleCrashed(state);
  const committed = await tryCommitSettled(client, state.gameId, settled);
  return committed ? { committed, balanceAfter: undefined } : null;
}

async function resolveBalance(client, state, hint) {
  if (typeof hint === "number") return hint;
  const after = await client.userCoinsCollection.findOne({
    userId: state.userId,
    guildId: state.guildId,
  });
  return after?.totalCoins || 0;
}

function start(client, gameDoc) {
  const { gameId } = gameDoc;
  if (tickers.has(gameId)) return;

  const ctx = {
    channelId: gameDoc.channelId,
    messageId: gameDoc.messageId,
  };

  const tick = async () => {
    try {
      // 每次 tick 都重讀 DB，避免被別條路徑搶先結算後還在 edit
      const state = await client.crashGamesCollection.findOne({ gameId });
      if (!state || state.status !== "playing") {
        stop(gameId);
        return;
      }

      const now = Date.now();

      // 1. bust 時間到
      if (now >= state.bustAt) {
        const res = await commitCrashed(client, state);
        if (res) {
          const balance = await resolveBalance(client, state);
          const payload = await buildSettledPayload(res.committed, {
            username: state.username,
            balance,
            userId: state.userId,
          });
          await editMessage(client, ctx, payload);
        }
        stop(gameId);
        return;
      }

      // 2. autocashout 時間到
      if (state.autocashoutAt && now >= state.autocashoutAt) {
        const settled = settleAutoCashout(state);
        if (settled) {
          const res = await commitCashout(client, state, settled);
          if (res) {
            const balance = await resolveBalance(
              client,
              state,
              res.balanceAfter,
            );
            const payload = await buildSettledPayload(res.committed, {
              username: state.username,
              balance,
              userId: state.userId,
            });
            await editMessage(client, ctx, payload);
          }
        }
        stop(gameId);
        return;
      }

      // 3. 一般 tick：edit 訊息顯示當下倍率
      const balance = await resolveBalance(client, state);
      const payload = buildPlayingPayload(state, {
        username: state.username,
        balance,
        userId: state.userId,
      });
      await editMessage(client, ctx, payload);
    } catch (e) {
      console.log(`[crash tick] gameId=${gameId} err=${e.message}`);
    }
  };

  // 起飛準時切換：火箭真正升空那一刻補一次 edit，讓「收手」按鈕剛好亮起。
  // （蓄勢期間 buildPlayingPayload 會把按鈕關著，過了 startedAt 才會亮）
  const startedAtMs =
    gameDoc.startedAt instanceof Date
      ? gameDoc.startedAt.getTime()
      : gameDoc.startedAt;
  const bustAtMs =
    gameDoc.bustAt instanceof Date ? gameDoc.bustAt.getTime() : gameDoc.bustAt;
  const launchDelayMs =
    typeof startedAtMs === "number" ? startedAtMs - Date.now() : 0;

  let launchTimeout = null;
  if (launchDelayMs > 0) {
    launchTimeout = setTimeout(async () => {
      try {
        // 已被搶先結算就不畫飛行畫面；剛好同時 bust 的瞬爆局交給 tick 收尾
        if (typeof bustAtMs === "number" && Date.now() >= bustAtMs) return;
        const state = await client.crashGamesCollection.findOne({ gameId });
        if (!state || state.status !== "playing") return;
        const balance = await resolveBalance(client, state);
        const payload = buildPlayingPayload(state, {
          username: state.username,
          balance,
          userId: state.userId,
        });
        await editMessage(client, ctx, payload);
      } catch (e) {
        console.log(`[crash launch] gameId=${gameId} err=${e.message}`);
      }
    }, launchDelayMs);
  }

  const intervalId = setInterval(tick, TICK_MS);
  tickers.set(gameId, { intervalId, launchTimeout });
}

module.exports = {
  start,
  stop,
  isRunning,
  tryCommitSettled,
  commitCashout,
  commitCrashed,
  resolveBalance,
  editMessage,
  TICK_MS,
};
