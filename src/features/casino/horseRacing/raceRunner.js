// 賽馬流程：售票 → 開賽 → 動畫 → 結算。被 /賽馬 setTimeout、按鈕、cron 共用。
//
// 防重靠 atomic findOneAndUpdate（status: "betting" → "running"）：
// 同一場若 setTimeout 跟 cron 同時觸發、或主機剛重啟 cron 又抓到一次，
// 只有第一個拿到 "betting" 狀態的呼叫者會繼續跑動畫，其它直接 no-op。

require("colors");

const { AttachmentBuilder } = require("discord.js");

const grantCoins = require("../../economy/grantCoins");
const { notifyEmbed } = require("../notifyAbandon");
const { MONEY_EMOJI } = require("../../../constants/coin");
const {
  HORSES,
  TRACK_LENGTH,
  pickWinnerWeighted,
  simulateRace,
  calcPayout,
} = require("./engine");
const {
  renderRunningPhase,
  renderSettledPhase,
  renderCancelled,
} = require("./renderer");
const generateHorseRaceResultCard = require("../../../utils/generateHorseRaceResultCard");
const generateHorseRaceGif = require("../../../utils/generateHorseRaceGif");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMessage(client, state) {
  if (!state?.channelId || !state?.messageId) return null;
  try {
    const channel = await client.channels.fetch(state.channelId);
    if (!channel?.isTextBased?.()) return null;
    return await channel.messages.fetch(state.messageId);
  } catch (_) {
    return null;
  }
}

// 把 betting 狀態的局推進到結束（開賽 / 取消）
// 0 人下注 → 取消；有下注 → 跑賽 + 結算
async function startRaceIfDue(client, gameId) {
  const coll = client.horseRaceGamesCollection;
  if (!coll) return;

  const current = await coll.findOne({ gameId });
  if (!current) return;
  if (current.status !== "betting") return;

  // 0 人下注：原子轉成 cancelled
  if (!current.bets || current.bets.length === 0) {
    const cancelled = await coll.findOneAndUpdate(
      { gameId, status: "betting" },
      {
        $set: {
          status: "cancelled",
          cancelReason: "no_bets",
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    const doc = cancelled?.value || cancelled;
    if (doc) {
      const message = await fetchMessage(client, doc);
      if (message) {
        const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
        await message
          .edit(renderCancelled(doc, "0 人購票，自動取消", { guild }))
          .catch(() => {});
      }
    }
    return;
  }

  // 原子轉成 running，搶到才繼續
  const running = await coll.findOneAndUpdate(
    { gameId, status: "betting" },
    { $set: { status: "running", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const state = running?.value || running;
  if (!state) return;

  await runRaceAnimation(client, state);
}

async function runRaceAnimation(client, state) {
  const coll = client.horseRaceGamesCollection;

  const winnerId = pickWinnerWeighted();
  const { frames, rankings } = simulateRace(winnerId);
  const finalPositions = frames[frames.length - 1];

  // 先把預計結果寫進 DB，這樣即使動畫掛掉，cron 也能用 finalPositions / rankings 結算
  await coll.updateOne(
    { gameId: state.gameId },
    {
      $set: {
        winnerId,
        rankings,
        finalPositions,
        updatedAt: new Date(),
      },
    },
  );

  const message = await fetchMessage(client, state);

  // 動畫：能拿到 message 就產一張 GIF 貼出，等播完再走結算
  if (message) {
    // GIF 編碼大約 3~5 秒，先做一次無附件 edit 讓按鈕消失、避免玩家對著舊 UI 戳。
    // 這次先不帶圖（withImage:false），embed 不 setImage 以免破圖。
    const racingPayload = renderRunningPhase(state);
    await message.edit({ ...racingPayload, attachments: [] }).catch(() => {});

    const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
    let waitMs = 5000;
    try {
      const { buffer, durationMs } = await generateHorseRaceGif({
        gameId: state.gameId,
        frames,
        pool: totalPool,
        betsCount: (state.bets || []).length,
        trackLength: TRACK_LENGTH,
      });
      const attachment = new AttachmentBuilder(buffer, {
        name: `race-${state.gameId}.gif`,
      });
      // 帶 GIF 的 edit：renderRunningPhase withImage:true 才會 setImage。
      await message
        .edit({ ...renderRunningPhase(state, { withImage: true }), files: [attachment] })
        .catch((e) =>
          console.log(
            `[HORSE] race gif edit failed (size=${buffer.length}B): ${e}`.yellow,
          ),
        );
      waitMs = durationMs;
    } catch (err) {
      console.log(`[HORSE] race gif render failed: ${err}`.yellow);
    }
    await sleep(waitMs);
  }

  // 結算：派彩給押中贏家的玩家
  const winnerHorse = HORSES.find((h) => h.id === winnerId);
  const settles = [];
  for (const bet of state.bets) {
    const won = bet.horseId === winnerId;
    const payout = won ? calcPayout(bet.amount, winnerHorse.payout) : 0;

    if (payout > 0) {
      await grantCoins(client, {
        userId: bet.userId,
        guildId: state.guildId,
        username: bet.username,
        amount: payout,
        source: "payout",
        meta: {
          game: "horseRacing",
          gameId: state.gameId,
          horseId: bet.horseId,
          winnerId,
          multiplier: winnerHorse.payout,
          bet: bet.amount,
        },
      }).catch((e) =>
        console.log(`[HORSE] payout failed for ${bet.userId}: ${e}`.red),
      );
    }

    settles.push({
      userId: bet.userId,
      username: bet.username,
      horseId: bet.horseId,
      amount: bet.amount,
      payout,
      won,
    });
  }

  await coll.updateOne(
    { gameId: state.gameId },
    {
      $set: {
        status: "settled",
        settles,
        updatedAt: new Date(),
      },
    },
  );

  const finalState = {
    ...state,
    winnerId,
    rankings,
    finalPositions,
    settles,
    status: "settled",
  };

  const guild = finalState.guildId ? client.guilds.cache.get(finalState.guildId) : null;
  const settledPayload = renderSettledPhase(finalState, { guild });
  const totalPool = (state.bets || []).reduce((s, b) => s + b.amount, 0);
  const totalPaid = settles.reduce((s, x) => s + (x.payout || 0), 0);

  let attachments = [];
  try {
    const buf = await generateHorseRaceResultCard({
      gameId: state.gameId,
      drawnAtLabel: new Date()
        .toISOString()
        .slice(0, 16)
        .replace("T", " "),
      horses: HORSES,
      rankings,
      finalPositions,
      trackLength: TRACK_LENGTH,
      pool: totalPool,
      paid: totalPaid,
      betsCount: (state.bets || []).length,
    });
    attachments = [
      new AttachmentBuilder(buf, { name: `race-${state.gameId}.png` }),
    ];
  } catch (err) {
    console.log(`[HORSE] result card render failed: ${err}`.yellow);
  }

  // attachments: [] 清掉跑賽用的 GIF；files 換成結果卡。
  const finalPayload = { ...settledPayload, attachments: [], files: attachments };

  if (message) {
    await message.edit(finalPayload).catch(() => {});
  } else {
    // 沒辦法 edit 原訊息：丟一筆訊息到頻道（若可達）
    try {
      const channel = await client.channels.fetch(state.channelId);
      if (channel?.isTextBased?.()) {
        await channel.send(finalPayload).catch(() => {});
      }
    } catch (_) { /* noop */ }
  }
}

// 把 betting 局原子取消（開盤者按取消鍵）
async function cancelRace(client, gameId, reason = "host_cancelled") {
  const coll = client.horseRaceGamesCollection;
  if (!coll) return null;

  const cancelled = await coll.findOneAndUpdate(
    { gameId, status: "betting" },
    {
      $set: {
        status: "cancelled",
        cancelReason: reason,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  const doc = cancelled?.value || cancelled;
  if (!doc) return null;

  // 退款
  for (const bet of doc.bets || []) {
    await grantCoins(client, {
      userId: bet.userId,
      guildId: doc.guildId,
      username: bet.username,
      amount: bet.amount,
      source: "payout", // 走 payout 通道避免被視作非賭場進帳
      meta: {
        game: "horseRacing",
        gameId: doc.gameId,
        kind: "refund",
        reason,
        horseId: bet.horseId,
      },
    }).catch((e) =>
      console.log(`[HORSE] refund failed for ${bet.userId}: ${e}`.red),
    );
  }
  await dmHorseRefunds(client, doc, "這場取消了");

  const message = await fetchMessage(client, doc);
  if (message) {
    const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
    await message
      .edit(renderCancelled(doc, reason === "host_cancelled" ? "開盤者取消" : "已取消", { guild }))
      .catch(() => {});
  }
  return doc;
}

// 把同一位玩家的多筆下注合併，逐人 DM 退款金額（避免多注多訊息洗版）
async function dmHorseRefunds(client, doc, reasonText) {
  const byUser = new Map();
  for (const bet of doc.bets || []) {
    byUser.set(bet.userId, (byUser.get(bet.userId) || 0) + (bet.amount || 0));
  }
  for (const [userId, amount] of byUser) {
    if (amount <= 0) continue;
    await notifyEmbed(client, userId, {
      title: "🐎 賽馬退款",
      description: `你押注的賽馬${reasonText}，退回 **${amount.toLocaleString()}** ${MONEY_EMOJI}。`,
    });
  }
}

// 卡住的 running 局退款（例如 bot 在動畫中段崩潰）
async function abandonStaleRace(client, gameId) {
  const coll = client.horseRaceGamesCollection;
  if (!coll) return null;

  const abandoned = await coll.findOneAndUpdate(
    { gameId, status: "running" },
    {
      $set: {
        status: "abandoned",
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  const doc = abandoned?.value || abandoned;
  if (!doc) return null;

  for (const bet of doc.bets || []) {
    await grantCoins(client, {
      userId: bet.userId,
      guildId: doc.guildId,
      username: bet.username,
      amount: bet.amount,
      source: "payout",
      meta: {
        game: "horseRacing",
        gameId: doc.gameId,
        kind: "refund",
        reason: "abandoned",
        horseId: bet.horseId,
      },
    }).catch(() => {});
  }
  await dmHorseRefunds(client, doc, "因故中斷，已自動退款");

  const message = await fetchMessage(client, doc);
  if (message) {
    const guild = doc.guildId ? client.guilds.cache.get(doc.guildId) : null;
    await message
      .edit(renderCancelled(doc, "比賽中斷，已自動退款", { guild }))
      .catch(() => {});
  }
  return doc;
}

module.exports = {
  startRaceIfDue,
  cancelRace,
  abandonStaleRace,
};
