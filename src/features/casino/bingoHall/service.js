// 賓果大廳場次生命週期：開場 → 賣卡 → 固定時間自動開球結算 → 公告 + 中獎 DM → 開下一場。
// 無需有人開房；排程每分鐘掃到 scheduledAt 到期的場次就開獎。

require("colors");
const crypto = require("crypto");
const { AttachmentBuilder } = require("discord.js");

const { casino } = require("../../../config");
const grantCoins = require("../../economy/grantCoins");
const { buildCard } = require("../bingo/engine");
const { settleRound } = require("./engine");
const {
  buildAnnounce,
  buildBuyMessage,
  buildClosedMessage,
} = require("./render");
const generateBingoHallCard = require("../../../utils/generateBingoHallCard");

function cfg() {
  return casino?.bingoHall || {};
}

function sampleBalls(n) {
  const pool = [];
  for (let v = 1; v <= 75; v++) pool.push(v);
  const out = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const r = crypto.randomInt(pool.length);
    out.push(pool[r]);
    pool.splice(r, 1);
  }
  return out;
}

async function getOpenRound(client) {
  if (!client.bingoHallRoundsCollection) return null;
  return client.bingoHallRoundsCollection.findOne({ status: "open" });
}

async function getChannel(client) {
  const id = cfg().announceChannelId;
  if (!id) return null;
  const ch = await client.channels.fetch(id).catch(() => null);
  return ch?.isTextBased?.() ? ch : null;
}

// 在公告頻道貼出該場的購買訊息（含買卡按鈕），並把 messageId 記回場次。
async function postBuyMessage(client, round) {
  const ch = await getChannel(client);
  if (!ch) return;
  const payload = buildBuyMessage(round, {
    ticketPrice: cfg().ticketPrice ?? 50,
    buyOptions: cfg().buyOptions,
  });
  const msg = await ch.send(payload).catch((e) => {
    console.log(`[BINGOHALL] 貼購買訊息失敗: ${e}`.yellow);
    return null;
  });
  if (msg) {
    round.messageId = msg.id;
    round.channelId = ch.id;
    await client.bingoHallRoundsCollection.updateOne(
      { roundId: round.roundId },
      { $set: { messageId: msg.id, channelId: ch.id, updatedAt: new Date() } }
    );
  }
}

// 開球後把舊購買訊息的按鈕收掉。
async function closeBuyMessage(client, round) {
  if (!round.messageId) return;
  const ch = await getChannel(client);
  if (!ch) return;
  const msg = await ch.messages.fetch(round.messageId).catch(() => null);
  if (msg) await msg.edit(buildClosedMessage(round)).catch(() => {});
}

async function ensureOpenRound(client) {
  if (!client.bingoHallRoundsCollection) return null;
  const c = cfg();
  if (c.enabled === false) return null;

  const existing = await getOpenRound(client);
  if (existing) {
    if (!existing.messageId) await postBuyMessage(client, existing); // 重啟/舊資料兜底
    return existing;
  }

  const last = await client.bingoHallRoundsCollection
    .find({ status: "settled" })
    .sort({ roundNumber: -1 })
    .limit(1)
    .toArray();
  const carriedJackpot = last[0]?.jackpotPoolOut ?? (c.jackpotSeed ?? 0);
  const roundNumber = (last[0]?.roundNumber || 0) + 1;
  const intervalMs = (c.drawIntervalMinutes ?? 360) * 60 * 1000;
  const now = new Date();

  const doc = {
    roundId: crypto.randomUUID(),
    roundNumber,
    status: "open",
    jackpotPoolIn: carriedJackpot,
    pool: 0,
    totalCards: 0,
    scheduledAt: new Date(now.getTime() + intervalMs),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await client.bingoHallRoundsCollection.insertOne(doc);
    console.log(`[BINGOHALL] 開新場 #${roundNumber}（累積大獎 ${carriedJackpot}，開球 ${doc.scheduledAt.toISOString()}）`.green);
    await postBuyMessage(client, doc);
    return doc;
  } catch (e) {
    if (e.code === 11000) return getOpenRound(client); // 已有 open 場
    throw e;
  }
}

async function buyCards(client, { userId, guildId, username, count, member }) {
  const c = cfg();
  const round = await ensureOpenRound(client);
  if (!round) return { ok: false, reason: "closed" };

  const price = c.ticketPrice ?? 50;
  const maxPer = c.maxCardsPerRound ?? 20;

  const owned = await client.bingoHallCardsCollection.countDocuments({
    roundId: round.roundId,
    userId,
  });
  if (owned + count > maxPer) {
    return { ok: false, reason: "max", maxPer, owned };
  }

  const cost = price * count;
  const before = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = before?.totalCoins || 0;
  if (balance < cost) return { ok: false, reason: "balance", balance, cost };

  const bet = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -cost,
    source: "bet",
    member,
    meta: { game: "bingoHall", roundId: round.roundId, count },
  });
  if (!bet) return { ok: false, reason: "debit" };

  const now = new Date();
  const cards = Array.from({ length: count }, () => ({
    cardId: crypto.randomUUID(),
    roundId: round.roundId,
    userId,
    guildId,
    username,
    card: buildCard(),
    pricePaid: price,
    lines: 0,
    prize: null,
    payout: 0,
    isFullHouse: false,
    createdAt: now,
  }));
  await client.bingoHallCardsCollection.insertMany(cards);

  const updated = await client.bingoHallRoundsCollection.findOneAndUpdate(
    { roundId: round.roundId, status: "open" },
    { $inc: { pool: cost, totalCards: count }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  const roundAfter = updated?.value || updated || round;
  const balanceAfter = bet.doc?.totalCoins ?? balance - cost;

  return {
    ok: true,
    round: roundAfter,
    cards,
    cost,
    balance: balanceAfter,
    totalCardsThisRound: owned + count,
  };
}

async function announce(client, round, settle, drawnBalls) {
  const channelId = cfg().announceChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const payload = buildAnnounce({ round, settle, drawnBalls });
  await channel.send(payload).catch((e) =>
    console.log(`[BINGOHALL] announce fail: ${e}`.yellow)
  );
}

// 對每張中獎卡 DM 一張兌獎圖 + 中獎金額；算圖失敗退回純文字。
async function dmWinners(client, round, settle, drawnBalls, cardsById) {
  const PRIZE_LABEL = { jackpot: "🏆 頭彩", lines: "🎯 連線獎" };
  for (const r of settle.results) {
    if (!(r.payout > 0)) continue;
    const cardDoc = cardsById.get(r.cardId);
    if (!cardDoc) continue;
    const user = await client.users.fetch(r.userId).catch(() => null);
    if (!user) continue;

    const headline =
      `🎉 你在 **賓果大廳 第 ${round.roundNumber} 場** 中獎了！\n` +
      `${PRIZE_LABEL[r.prize] || "中獎"}（${r.lines} 線）→ **+${r.payout.toLocaleString()}** credits 已入帳。`;

    let files = [];
    try {
      const buf = await generateBingoHallCard({
        card: cardDoc.card,
        drawnBalls,
        lines: r.lines,
        prize: r.prize,
        payout: r.payout,
        roundNumber: round.roundNumber,
        username: cardDoc.username,
      });
      files = [new AttachmentBuilder(buf, { name: `bingo-${r.cardId}.png` })];
    } catch (e) {
      console.log(`[BINGOHALL] 兌獎圖算圖失敗 ${r.cardId}: ${e.message}`.yellow);
    }
    await user.send({ content: headline, files }).catch(() => {});
  }
}

async function settleAndAnnounce(client, round) {
  const c = cfg();
  const ballsDrawn = c.ballsDrawn ?? 30;
  const drawnBalls = sampleBalls(ballsDrawn);

  // 先收掉舊購買訊息的按鈕（避免開球後還有人點）
  await closeBuyMessage(client, round).catch(() => {});

  const cards = await client.bingoHallCardsCollection
    .find({ roundId: round.roundId })
    .toArray();

  if (cards.length === 0) {
    await client.bingoHallRoundsCollection.updateOne(
      { roundId: round.roundId },
      {
        $set: {
          status: "settled",
          drawnBalls,
          settledAt: new Date(),
          jackpotPoolOut: round.jackpotPoolIn || 0,
          updatedAt: new Date(),
        },
      }
    );
    console.log(`[BINGOHALL] #${round.roundNumber} 無人購卡，大獎滾存`.gray);
    return;
  }

  const settle = settleRound({
    cards,
    drawnBalls,
    pool: round.pool || 0,
    jackpotPoolIn: round.jackpotPoolIn || 0,
    rakePct: c.rakePct ?? 0.12,
    jackpotShare: c.jackpotShare ?? 0.4,
  });

  const cardsById = new Map(cards.map((c2) => [c2.cardId, c2]));
  const ops = [];
  for (const r of settle.results) {
    ops.push({
      updateOne: {
        filter: { cardId: r.cardId },
        update: {
          $set: {
            lines: r.lines,
            prize: r.prize,
            payout: r.payout,
            isFullHouse: r.isFullHouse,
          },
        },
      },
    });
    if (r.payout > 0) {
      const cd = cardsById.get(r.cardId);
      await grantCoins(client, {
        userId: r.userId,
        guildId: cd?.guildId,
        username: r.username,
        amount: r.payout,
        source: "payout",
        meta: {
          game: "bingoHall",
          roundId: round.roundId,
          cardId: r.cardId,
          prize: r.prize,
          lines: r.lines,
        },
      });
    }
  }
  if (ops.length) await client.bingoHallCardsCollection.bulkWrite(ops, { ordered: false });

  await client.bingoHallRoundsCollection.updateOne(
    { roundId: round.roundId },
    {
      $set: {
        status: "settled",
        drawnBalls,
        settledAt: new Date(),
        jackpotPoolOut: settle.jackpotPoolOut,
        settleSummary: {
          rake: settle.rake,
          jackpotPaid: settle.jackpotPaid,
          linesPaid: settle.linesPaid,
          jackpotWinners: settle.jackpotWinners,
          lineWinners: settle.lineWinners,
        },
        updatedAt: new Date(),
      },
    }
  );

  console.log(
    `[BINGOHALL] #${round.roundNumber} 開獎完成：頭彩 ${settle.jackpotWinners} 人、連線中獎 ${settle.lineWinners} 人、頭彩滾存 ${settle.jackpotPoolOut}`.cyan
  );

  await announce(client, round, settle, drawnBalls);
  await dmWinners(client, round, settle, drawnBalls, cardsById);
}

async function runDueDraws(client) {
  if (!client.bingoHallRoundsCollection) return;
  const now = new Date();
  const locked = await client.bingoHallRoundsCollection.findOneAndUpdate(
    { status: "open", scheduledAt: { $lte: now } },
    { $set: { status: "drawing", updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  const round = locked?.value || locked;
  if (!round) {
    await ensureOpenRound(client);
    return;
  }
  await settleAndAnnounce(client, round);
  await ensureOpenRound(client);
  return runDueDraws(client); // 處理可能堆積的多場
}

module.exports = {
  getOpenRound,
  ensureOpenRound,
  buyCards,
  runDueDraws,
  settleAndAnnounce,
  sampleBalls,
};
