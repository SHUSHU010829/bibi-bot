const { randomInt } = require("../utils/levelMath");
const grantXp = require("../features/leveling/grantXp");
const grantCoins = require("../features/economy/grantCoins");
const { twitchSync, levelSystem, coinSystem } = require("../config");
const logger = require("../utils/logger");
const { trackError, trackSuccess } = require("../utils/errorTracker");

function rollSessionXp(messageCount) {
  const min = levelSystem?.message?.minXp ?? 15;
  const max = levelSystem?.message?.maxXp ?? 25;
  const cap = twitchSync?.perSessionXpCap ?? 1000;
  let total = 0;
  for (let i = 0; i < messageCount; i += 1) {
    total += randomInt(min, max);
    if (total >= cap) return cap;
  }
  return total;
}

function rollSessionCoins(messageCount) {
  const cfg = twitchSync?.coinPayout;
  if (!cfg?.enabled) return 0;
  const min = cfg?.perMessage?.min ?? 3;
  const max = cfg?.perMessage?.max ?? 7;
  const cap = cfg?.perSessionCap ?? 1000;
  let total = 0;
  for (let i = 0; i < messageCount; i += 1) {
    total += randomInt(min, max);
    if (total >= cap) return cap;
  }
  return total;
}

function getRankingBonus(rank) {
  const bonuses = twitchSync?.coinPayout?.rankingBonuses;
  if (!Array.isArray(bonuses) || rank < 1 || rank > bonuses.length) return 0;
  return Number(bonuses[rank - 1]) || 0;
}

async function buildMemberIndex(client) {
  if (!twitchSync?.guildId) return null;
  const guild = client.guilds.cache.get(twitchSync.guildId)
    || (await client.guilds.fetch(twitchSync.guildId).catch(() => null));
  if (!guild) {
    logger.warn({ source: "twitch-flush", guildId: twitchSync.guildId }, "guild not found");
    trackError("twitch-flush", new Error("guild not found"), { guildId: twitchSync.guildId });
    return null;
  }

  const members = await guild.members.fetch().catch((e) => {
    logger.error({ source: "twitch-flush", err: e.message }, "members.fetch failed");
    trackError("twitch-flush", e, { phase: "members.fetch" });
    return null;
  });
  if (!members) return null;

  const index = new Map();
  for (const member of members.values()) {
    const username = (member.user?.username || "").toLowerCase();
    if (!username) continue;
    if (!index.has(username)) index.set(username, member);
  }
  return index;
}

module.exports = function createFlushChatScoreHandler(client) {
  return async function handleFlushChatScore(req, res) {
    if (!twitchSync?.enabled) {
      return res.status(503).json({ error: "twitch sync disabled" });
    }

    const expectedSecret = process.env.DISCORD_BOT_SCORE_SECRET;
    if (!expectedSecret) {
      logger.error({ source: "twitch-flush" }, "DISCORD_BOT_SCORE_SECRET not configured");
      trackError("twitch-flush", new Error("secret not configured"));
      return res.status(500).json({ error: "secret not configured" });
    }

    const auth = req.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided || provided !== expectedSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid payload" });
    }
    const { sessionId, channel, channelId, scores } = body;
    if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) {
      return res.status(400).json({ error: "missing sessionId" });
    }
    if (!Array.isArray(scores)) {
      return res.status(400).json({ error: "missing scores" });
    }

    const flushes = client.twitchScoreFlushesCollection;
    if (!flushes) {
      return res.status(503).json({ error: "db not ready" });
    }

    // Idempotency check.
    const existing = await flushes.findOne({ sessionId }).catch(() => null);
    if (existing) {
      return res.status(200).json({
        ok: true,
        sessionId,
        idempotent: true,
        appliedUserCount: existing.appliedUserCount ?? 0,
        appliedCoinTotal: existing.appliedCoinTotal ?? 0,
      });
    }

    const memberIndex = await buildMemberIndex(client);
    if (!memberIndex) {
      return res.status(503).json({ error: "guild not ready" });
    }

    const guildId = twitchSync.guildId;
    const minThreshold = twitchSync?.minMessageThreshold ?? 0;
    const coinPayoutEnabled = twitchSync?.coinPayout?.enabled === true
      && coinSystem?.enabled !== false;

    // Filter + normalise eligible scores, then sort by count desc for ranking.
    const eligible = [];
    let skipped = 0;
    const skippedLogins = [];
    let belowThreshold = 0;

    for (const score of scores) {
      const login = String(score?.twitchLogin || "").toLowerCase();
      const count = Number(score?.count) || 0;
      if (!login || count <= 0) continue;
      if (count < minThreshold) {
        belowThreshold += 1;
        continue;
      }
      const member = memberIndex.get(login);
      if (!member) {
        skipped += 1;
        if (skippedLogins.length < 20) skippedLogins.push(login);
        continue;
      }
      eligible.push({
        login,
        count,
        member,
        displayName: score?.twitchDisplayName || login,
      });
    }

    eligible.sort((a, b) => b.count - a.count);

    let applied = 0;
    let appliedCoinTotal = 0;
    let appliedXpTotal = 0;
    const rankingPayouts = [];

    for (let i = 0; i < eligible.length; i += 1) {
      const entry = eligible[i];
      const rank = i + 1;
      const xp = rollSessionXp(entry.count);
      const perMessageCoin = coinPayoutEnabled ? rollSessionCoins(entry.count) : 0;
      const rankingBonus = coinPayoutEnabled ? getRankingBonus(rank) : 0;
      const totalCoin = perMessageCoin + rankingBonus;

      const sharedMeta = {
        sessionId,
        twitchLogin: entry.login,
        twitchDisplayName: entry.displayName,
        twitchChannel: channel,
        twitchChannelId: channelId,
        messageCount: entry.count,
        rank,
      };

      try {
        if (xp > 0) {
          await grantXp(client, {
            userId: entry.member.user.id,
            guildId,
            username: entry.member.user.username,
            avatarHash: entry.member.user.avatar,
            amount: xp,
            source: "twitch_chat",
            counterField: "xpFromTwitchChat",
            incrementMessages: false,
            meta: sharedMeta,
            member: entry.member,
          });
          appliedXpTotal += xp;
        }
      } catch (err) {
        logger.error(
          { source: "twitch-flush", login: entry.login, err: err.message },
          "grantXp failed"
        );
        trackError("twitch-flush", err, { phase: "grantXp", login: entry.login });
      }

      if (totalCoin > 0) {
        try {
          await grantCoins(client, {
            userId: entry.member.user.id,
            guildId,
            username: entry.member.user.username,
            avatarHash: entry.member.user.avatar,
            amount: totalCoin,
            source: "twitch_chat",
            meta: {
              ...sharedMeta,
              perMessageCoin,
              rankingBonus,
            },
            member: entry.member,
          });
          appliedCoinTotal += totalCoin;
          if (rankingBonus > 0) {
            rankingPayouts.push({
              rank,
              login: entry.login,
              userId: entry.member.user.id,
              bonus: rankingBonus,
            });
          }
        } catch (err) {
          logger.error(
            { source: "twitch-flush", login: entry.login, err: err.message },
            "grantCoins failed"
          );
          trackError("twitch-flush", err, { phase: "grantCoins", login: entry.login });
        }
      }

      if (xp > 0 || totalCoin > 0) applied += 1;
    }

    try {
      await flushes.insertOne({
        sessionId,
        channel: channel || null,
        channelId: channelId || null,
        appliedUserCount: applied,
        skippedUserCount: skipped,
        belowThresholdCount: belowThreshold,
        totalScoreCount: scores.length,
        appliedXpTotal,
        appliedCoinTotal,
        rankingPayouts,
        flushedAt: new Date(),
      });
    } catch (err) {
      // Race: another request inserted while we were processing.
      if (!(err && err.code === 11000)) {
        logger.error(
          { source: "twitch-flush", sessionId, err: err.message },
          "insert flush record failed"
        );
        trackError("twitch-flush", err, { phase: "insert", sessionId });
      }
    }

    logger.info(
      {
        source: "twitch-flush",
        sessionId,
        applied,
        skipped,
        belowThreshold,
        appliedXpTotal,
        appliedCoinTotal,
        total: scores.length,
      },
      "twitch flush done"
    );
    trackSuccess("twitch-flush");

    return res.status(200).json({
      ok: true,
      sessionId,
      applied,
      skipped,
      belowThreshold,
      total: scores.length,
      appliedXpTotal,
      appliedCoinTotal,
      rankingPayouts,
      sampleSkippedLogins: skippedLogins,
    });
  };
};
