require("colors");
const crypto = require("crypto");
const { DateTime } = require("luxon");
const { dungeon } = require("../../config");
const { getOrCreate } = require("./miningProfile");
const { playerAtk } = require("./dungeonService");
const grantCoins = require("../economy/grantCoins");

const TZ = dungeon?.timezone || "Asia/Taipei";

function cfg() {
  return dungeon?.duel || {};
}

const randInt = (max) => Math.floor(Math.random() * (max + 1)); // 0..max（含）

async function getBalance(client, userId, guildId) {
  const doc = await client.userCoinsCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  return doc?.totalCoins || 0;
}

// 發起決鬥：扣除挑戰者賭注（託管），建立 pending 對局。
async function createDuel(
  client,
  { guildId, channelId, challengerId, challengerName, opponentId, opponentName, bet, member }
) {
  const c = cfg();
  if (!dungeon?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.duelGamesCollection || !client.userCoinsCollection) {
    return { ok: false, reason: "disabled" };
  }

  const minBet = c.minBet ?? 10;
  const maxBet = c.maxBet ?? 5000;
  if (!Number.isFinite(bet) || bet < minBet || bet > maxBet) {
    return { ok: false, reason: "bad_bet", minBet, maxBet };
  }

  const existing = await client.duelGamesCollection.findOne({
    guild_id: guildId,
    challenger_id: challengerId,
    status: "pending",
  });
  if (existing) return { ok: false, reason: "already_pending" };

  // 每日場次上限（以挑戰者當日已完成的發起場數計）
  const dailyLimit = c.dailyLimit ?? 0;
  if (dailyLimit > 0) {
    const dayStart = DateTime.now().setZone(TZ).startOf("day").toJSDate();
    const todayCount = await client.duelGamesCollection
      .countDocuments({
        guild_id: guildId,
        challenger_id: challengerId,
        status: "completed",
        completed_at: { $gte: dayStart },
      })
      .catch(() => 0);
    if (todayCount >= dailyLimit) {
      return { ok: false, reason: "daily_limit", dailyLimit, todayCount };
    }
  }

  // 同對手冷卻：近 N 小時內與同一對手（不分方向）已對戰過則擋下
  const pairCdMs = c.samePairCooldownMs ?? 0;
  if (pairCdMs > 0) {
    const since = new Date(Date.now() - pairCdMs);
    const recent = await client.duelGamesCollection
      .findOne(
        {
          guild_id: guildId,
          status: "completed",
          completed_at: { $gte: since },
          $or: [
            { challenger_id: challengerId, opponent_id: opponentId },
            { challenger_id: opponentId, opponent_id: challengerId },
          ],
        },
        { sort: { completed_at: -1 } }
      )
      .catch(() => null);
    if (recent?.completed_at) {
      const readyAt = new Date(recent.completed_at).getTime() + pairCdMs;
      return { ok: false, reason: "pair_cooldown", readyAt };
    }
  }

  const balance = await getBalance(client, challengerId, guildId);
  if (balance < bet) return { ok: false, reason: "insufficient", balance };

  const duelId = crypto.randomUUID();

  const debit = await grantCoins(client, {
    userId: challengerId,
    guildId,
    username: challengerName,
    amount: -bet,
    source: "duel_stake",
    member,
    meta: { duelId, role: "challenger" },
  });
  if (!debit) return { ok: false, reason: "grant_failed" };

  const now = Date.now();
  const expiresAt = now + (c.acceptWindowMs ?? 120000);
  await client.duelGamesCollection.insertOne({
    duel_id: duelId,
    guild_id: guildId,
    channel_id: channelId,
    challenger_id: challengerId,
    challenger_name: challengerName,
    opponent_id: opponentId,
    opponent_name: opponentName,
    bet,
    status: "pending",
    created_at: new Date(),
    expires_at: new Date(expiresAt),
  });

  return { ok: true, duelId, bet, expiresAt };
}

// 對手接受：扣其賭注、判定勝負、發放彩池。
async function acceptDuel(client, { duelId, opponentId, opponentName, member }) {
  if (!client.duelGamesCollection) return { ok: false, reason: "disabled" };
  const c = cfg();

  const duel = await client.duelGamesCollection.findOne({ duel_id: duelId });
  if (!duel || duel.status !== "pending") return { ok: false, reason: "not_found" };
  if (Date.now() > new Date(duel.expires_at).getTime()) {
    return { ok: false, reason: "expired" };
  }
  if (opponentId !== duel.opponent_id) return { ok: false, reason: "not_opponent" };

  const balance = await getBalance(client, opponentId, duel.guild_id);
  if (balance < duel.bet) return { ok: false, reason: "insufficient", balance };

  // 扣對手賭注
  const debit = await grantCoins(client, {
    userId: opponentId,
    guildId: duel.guild_id,
    username: opponentName,
    amount: -duel.bet,
    source: "duel_stake",
    member,
    meta: { duelId, role: "opponent" },
  });
  if (!debit) return { ok: false, reason: "grant_failed" };

  // 鎖定對局，避免重複接受
  const locked = await client.duelGamesCollection.findOneAndUpdate(
    { duel_id: duelId, status: "pending" },
    { $set: { status: "resolving", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) {
    // 已被處理（接受/取消/逾時）→ 退回剛扣的賭注
    await grantCoins(client, {
      userId: opponentId,
      guildId: duel.guild_id,
      username: opponentName,
      amount: duel.bet,
      source: "duel_refund",
      member,
      meta: { duelId, reason: "race" },
    }).catch(() => {});
    return { ok: false, reason: "race" };
  }

  // 判定勝負：分數 = 攻擊力 + 隨機(0~scoreRandMax)，分數高者勝（平手判挑戰者勝）
  const [cProfile, oProfile] = await Promise.all([
    getOrCreate(client, duel.challenger_id, duel.guild_id),
    getOrCreate(client, opponentId, duel.guild_id),
  ]);
  const atkC = playerAtk(cProfile);
  const atkO = playerAtk(oProfile);
  const randMax = c.scoreRandMax ?? 30;
  const scoreC = atkC + randInt(randMax);
  const scoreO = atkO + randInt(randMax);
  const challengerWins = scoreC >= scoreO;
  const winnerId = challengerWins ? duel.challenger_id : opponentId;
  const winnerName = challengerWins ? duel.challenger_name : opponentName;
  const loserId = challengerWins ? opponentId : duel.challenger_id;

  // 彩池抽水：雙方各押 bet（共 2×bet），系統抽 systemRakePct，餘額給勝者
  const rakePct = c.systemRakePct ?? 0;
  const grossPot = duel.bet * 2;
  const pot = Math.floor(grossPot * (1 - rakePct));
  const rakeAmount = grossPot - pot;
  const winnerMember = challengerWins ? null : member; // member 為對手；挑戰者 member 不在手上
  const payout = await grantCoins(client, {
    userId: winnerId,
    guildId: duel.guild_id,
    username: winnerName,
    amount: pot,
    source: "duel_payout",
    member: winnerMember,
    meta: { duelId, bet: duel.bet, rake: rakeAmount },
  });

  await client.duelGamesCollection.updateOne(
    { duel_id: duelId },
    {
      $set: {
        status: "completed",
        winner_id: winnerId,
        loser_id: loserId,
        score_challenger: scoreC,
        score_opponent: scoreO,
        pot,
        rake: rakeAmount,
        completed_at: new Date(),
        updated_at: new Date(),
      },
    }
  );

  return {
    ok: true,
    duel,
    winnerId,
    loserId,
    challengerWins,
    atkChallenger: atkC,
    atkOpponent: atkO,
    scoreChallenger: scoreC,
    scoreOpponent: scoreO,
    pot,
    rakeAmount,
    winnerBalance: payout?.doc?.totalCoins ?? null,
  };
}

// 個人決鬥戰績：最近 N 場 + 累積勝負。
async function getHistory(client, { guildId, userId, limit = 10 }) {
  if (!client.duelGamesCollection) {
    return { recent: [], wins: 0, losses: 0, total: 0 };
  }
  const participantFilter = {
    guild_id: guildId,
    status: "completed",
    $or: [{ challenger_id: userId }, { opponent_id: userId }],
  };
  const [recent, wins, total] = await Promise.all([
    client.duelGamesCollection
      .find(participantFilter)
      .sort({ completed_at: -1 })
      .limit(limit)
      .toArray()
      .catch(() => []),
    client.duelGamesCollection
      .countDocuments({ guild_id: guildId, status: "completed", winner_id: userId })
      .catch(() => 0),
    client.duelGamesCollection.countDocuments(participantFilter).catch(() => 0),
  ]);
  return { recent, wins, losses: total - wins, total };
}

// 拒絕 / 取消：退回挑戰者賭注。
async function declineDuel(client, { duelId, byUserId }) {
  if (!client.duelGamesCollection) return { ok: false, reason: "disabled" };

  const duel = await client.duelGamesCollection.findOne({ duel_id: duelId });
  if (!duel || duel.status !== "pending") return { ok: false, reason: "not_found" };
  if (byUserId !== duel.opponent_id && byUserId !== duel.challenger_id) {
    return { ok: false, reason: "not_participant" };
  }

  const locked = await client.duelGamesCollection.findOneAndUpdate(
    { duel_id: duelId, status: "pending" },
    { $set: { status: "declined", declined_by: byUserId, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  await grantCoins(client, {
    userId: duel.challenger_id,
    guildId: duel.guild_id,
    username: duel.challenger_name,
    amount: duel.bet,
    source: "duel_refund",
    meta: { duelId, reason: "declined" },
  }).catch(() => {});

  return { ok: true, duel, byUserId };
}

// 逾時清理（cron 用）：退回挑戰者賭注。
async function expireDuel(client, duel) {
  const locked = await client.duelGamesCollection.findOneAndUpdate(
    { duel_id: duel.duel_id, status: "pending" },
    { $set: { status: "expired", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return false;

  await grantCoins(client, {
    userId: duel.challenger_id,
    guildId: duel.guild_id,
    username: duel.challenger_name,
    amount: duel.bet,
    source: "duel_refund",
    meta: { duelId: duel.duel_id, reason: "expired" },
  }).catch(() => {});
  return true;
}

module.exports = { createDuel, acceptDuel, declineDuel, expireDuel, getHistory };
