require("colors");
const crypto = require("crypto");
const { dungeon } = require("../../config");
const { getOrCreate } = require("./miningProfile");
const { playerAtk } = require("./dungeonService");
const grantCoins = require("../economy/grantCoins");

function cfg() {
  return dungeon?.duel || {};
}

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

  // 判定勝負：攻擊力越高勝率越高
  const [cProfile, oProfile] = await Promise.all([
    getOrCreate(client, duel.challenger_id, duel.guild_id),
    getOrCreate(client, opponentId, duel.guild_id),
  ]);
  const atkC = playerAtk(cProfile);
  const atkO = playerAtk(oProfile);
  const challengerWinRate = atkC / (atkC + atkO || 1);
  const challengerWins = Math.random() < challengerWinRate;
  const winnerId = challengerWins ? duel.challenger_id : opponentId;
  const winnerName = challengerWins ? duel.challenger_name : opponentName;
  const loserId = challengerWins ? opponentId : duel.challenger_id;

  const pot = duel.bet * 2;
  const winnerMember = challengerWins ? null : member; // member 為對手；挑戰者 member 不在手上
  const payout = await grantCoins(client, {
    userId: winnerId,
    guildId: duel.guild_id,
    username: winnerName,
    amount: pot,
    source: "duel_payout",
    member: winnerMember,
    meta: { duelId, bet: duel.bet },
  });

  await client.duelGamesCollection.updateOne(
    { duel_id: duelId },
    {
      $set: {
        status: "completed",
        winner_id: winnerId,
        loser_id: loserId,
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
    challengerWinRate,
    pot,
    winnerBalance: payout?.doc?.totalCoins ?? null,
  };
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

module.exports = { createDuel, acceptDuel, declineDuel, expireDuel };
