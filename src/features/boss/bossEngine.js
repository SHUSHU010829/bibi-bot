require("colors");
const { boss, serverId } = require("../../config");
const buffResolver = require("../buff/buffResolver");
const { getOrCreate } = require("../mining/miningProfile");
const { resolveStamina, staminaMax, getMemberClub } = require("../mining/dungeonService");

function cfg() {
  return boss || {};
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function phaseOf(currentHp, maxHp) {
  const ratio = maxHp > 0 ? currentHp / maxHp : 0;
  const phases = cfg().phases || {};
  if (ratio <= (phases.enraged?.hpThreshold ?? 0.2)) return "enraged";
  if (ratio <= (phases.broken?.hpThreshold ?? 0.5)) return "broken";
  return "normal";
}

function phaseDef(name) {
  return cfg().phases?.[name] || cfg().phases?.normal || {};
}

function comboCfg() {
  return cfg().combo || {};
}

function rewardsCfg() {
  return cfg().rewards || {};
}

async function countOnlineMembers(client) {
  const guild = client.guilds.cache.get(serverId);
  if (!guild) return 0;
  let online = 0;
  for (const m of guild.members.cache.values()) {
    if (m.user.bot) continue;
    const status = m.presence?.status;
    if (status && status !== "offline") online++;
  }
  return online;
}

async function getActiveBoss(client, guildId) {
  if (!client.bossEventsCollection) return null;
  return client.bossEventsCollection.findOne({ guild_id: guildId, status: "active" });
}

async function spawnBoss(client, { guildId, name, emoji, hp, durationMs }) {
  const now = Date.now();
  const existing = await getActiveBoss(client, guildId);
  if (existing) return { ok: false, reason: "already_active", boss: existing };

  const onlineCount = hp == null ? await countOnlineMembers(client) : null;
  const finalHp = hp != null
    ? hp
    : Math.max(cfg().minHp ?? 3000, onlineCount * (cfg().hpPerPlayer ?? 500));
  const duration = durationMs ?? (cfg().durationMinutes ?? 30) * 60 * 1000;
  const bossId = `boss_${guildId}_${now}`;

  const doc = {
    boss_id: bossId,
    guild_id: guildId,
    name: name || cfg().saturdaySpawn?.name || "巨龍",
    emoji: emoji || cfg().saturdaySpawn?.emoji || "🐉",
    max_hp: finalHp,
    current_hp: finalHp,
    phase: "normal",
    status: "active",
    started_at: now,
    ends_at: now + duration,
    killer_user_id: null,
    online_count: onlineCount ?? null,
    combo: {
      count: 0,
      last_user: null,
      last_ts: 0,
      same_user_streak: 0,
      active_until: 0,
      combo_mvp: null,
    },
    attack_counts: {},
  };
  await client.bossEventsCollection.insertOne(doc);
  return { ok: true, boss: doc };
}

async function getBossInfo(client, guildId) {
  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_active" };
  const logs = await client.bossDamageLogsCollection
    .find({ boss_id: bossDoc.boss_id, is_counter: false })
    .toArray();
  const byUser = new Map();
  for (const l of logs) {
    byUser.set(l.user_id, (byUser.get(l.user_id) || 0) + l.damage);
  }
  const ranking = [...byUser.entries()]
    .map(([userId, dmg]) => ({ userId, damage: dmg }))
    .sort((a, b) => b.damage - a.damage);
  const totalDamage = ranking.reduce((s, r) => s + r.damage, 0);
  return {
    ok: true,
    boss: bossDoc,
    ranking,
    totalDamage,
    comboActive: Date.now() < (bossDoc.combo?.active_until || 0),
  };
}

async function applyAttack(client, { userId, guildId, username, member }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_active" };
  const now = Date.now();
  if (now >= bossDoc.ends_at) return { ok: false, reason: "expired" };

  const attackLimit = cfg().attackLimitPerPlayer ?? 5;
  const used = (bossDoc.attack_counts || {})[userId] || 0;
  if (used >= attackLimit) {
    return { ok: false, reason: "attack_limit", used, limit: attackLimit };
  }

  // 體力檢查（與地下城共用）
  const profile = await getOrCreate(client, userId, guildId);
  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const st = resolveStamina(profile, max);
  if (st.stamina <= 0) {
    return {
      ok: false,
      reason: "no_stamina",
      nextRegenAt: st.nextRegenAt,
      max,
    };
  }

  // Combo / streak 狀態判定
  const combo = bossDoc.combo || {};
  const comboCfgVal = comboCfg();
  const phaseName = bossDoc.phase || phaseOf(bossDoc.current_hp, bossDoc.max_hp);
  const phase = phaseDef(phaseName);
  const counterRate = phase.counterRate ?? 0.1;
  const isCounter = Math.random() < counterRate;

  let sameUserStreak = 1;
  if (combo.last_user === userId) {
    sameUserStreak = (combo.same_user_streak || 0) + 1;
  }

  let comboCount = combo.count || 0;
  let comboLastTs = combo.last_ts || 0;
  let comboLastUser = combo.last_user || null;
  let comboActiveUntil = combo.active_until || 0;
  let comboMvp = combo.combo_mvp || null;
  let comboTriggered = false;

  if (!isCounter) {
    const windowMs = (comboCfgVal.windowSec ?? 10) * 1000;
    if (comboLastUser && userId !== comboLastUser && now - comboLastTs <= windowMs) {
      comboCount += 1;
    } else if (!comboLastUser || userId !== comboLastUser) {
      comboCount = 1;
    }
    if (comboCount >= (comboCfgVal.triggerCount ?? 5)) {
      comboTriggered = true;
      comboActiveUntil = now + (comboCfgVal.durationSec ?? 120) * 1000;
      comboMvp = userId;
      comboCount = 0;
    }
    comboLastUser = userId;
    comboLastTs = now;
  }

  // 傷害計算
  let damage = 0;
  if (!isCounter) {
    const sum = await buffResolver.summary(client, userId, guildId, member).catch(() => null);
    const atk = sum?.atk ?? (await buffResolver.getEffectiveAtk(client, userId, guildId));
    const luck = sum?.luckBonus ?? 0;
    const dmgCfg = cfg().damage || {};
    const base = atk
      + rand(dmgCfg.baseRandMin ?? 10, dmgCfg.baseRandMax ?? 50)
      + luck * (dmgCfg.luckBonusMult ?? 20);
    const streakMult = Math.max(
      comboCfgVal.sameUserMinMult ?? 0.5,
      1 - (sameUserStreak - 1) * (comboCfgVal.sameUserDecay ?? 0.1),
    );
    const comboActive = now < comboActiveUntil;
    const comboMult = comboActive ? (comboCfgVal.bonusMult ?? 1.3) : 1;
    damage = Math.max(1, Math.floor(base * (phase.damageMult ?? 1) * streakMult * comboMult));
  }

  // 體力扣除
  const wasFull = st.stamina >= max;
  const newStamina = Math.max(0, st.stamina - (isCounter ? 2 : 1));
  const newUpdatedAt = wasFull ? now : st.updatedAt;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $set: {
        stamina: newStamina,
        stamina_updated_at: newUpdatedAt,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  ).catch(() => {});

  // BOSS 血量扣除 + 階段更新
  let newHp = Math.max(0, (bossDoc.current_hp ?? bossDoc.max_hp) - damage);
  const killed = newHp <= 0;
  const newPhase = phaseOf(newHp, bossDoc.max_hp);
  const phaseChanged = newPhase !== bossDoc.phase;

  const bossUpdate = {
    $set: {
      current_hp: newHp,
      phase: newPhase,
      "combo.count": comboCount,
      "combo.last_user": comboLastUser,
      "combo.last_ts": comboLastTs,
      "combo.same_user_streak": sameUserStreak,
      "combo.active_until": comboActiveUntil,
      "combo.combo_mvp": comboMvp,
      [`attack_counts.${userId}`]: used + 1,
      updatedAt: new Date(),
    },
  };
  if (killed) {
    bossUpdate.$set.status = "defeated";
    bossUpdate.$set.killer_user_id = userId;
    bossUpdate.$set.killed_at = now;
  }
  await client.bossEventsCollection.updateOne({ boss_id: bossDoc.boss_id }, bossUpdate);

  // 傷害紀錄
  await client.bossDamageLogsCollection.insertOne({
    boss_id: bossDoc.boss_id,
    guild_id: guildId,
    user_id: userId,
    username,
    damage,
    is_counter: isCounter,
    combo_active: now < comboActiveUntil,
    phase: newPhase,
    ts: now,
  });

  return {
    ok: true,
    damage,
    isCounter,
    phaseBefore: bossDoc.phase,
    phaseAfter: newPhase,
    phaseChanged,
    comboTriggered,
    comboActive: now < comboActiveUntil,
    comboActiveUntil,
    comboMvp,
    sameUserStreak,
    killed,
    killerUserId: killed ? userId : null,
    boss: { ...bossDoc, current_hp: newHp, phase: newPhase },
    stamina: newStamina,
    staminaMax: max,
    attackCount: used + 1,
    attackLimit,
  };
}

async function settleBoss(client, bossDoc) {
  if (!bossDoc) return null;
  if (bossDoc.status !== "active" && bossDoc.status !== "defeated") return null;

  const logs = await client.bossDamageLogsCollection.find({ boss_id: bossDoc.boss_id }).toArray();
  const dmgByUser = new Map();
  const counterByUser = new Map();
  const attackByUser = new Map();
  for (const l of logs) {
    if (l.is_counter) {
      counterByUser.set(l.user_id, (counterByUser.get(l.user_id) || 0) + 1);
    } else {
      dmgByUser.set(l.user_id, (dmgByUser.get(l.user_id) || 0) + l.damage);
    }
    attackByUser.set(l.user_id, (attackByUser.get(l.user_id) || 0) + 1);
  }
  const ranking = [...dmgByUser.entries()]
    .map(([userId, damage]) => ({
      userId,
      damage,
      counters: counterByUser.get(userId) || 0,
      attacks: attackByUser.get(userId) || 0,
      username: logs.find((x) => x.user_id === userId)?.username || "",
    }))
    .sort((a, b) => b.damage - a.damage);
  const totalDamage = ranking.reduce((s, r) => s + r.damage, 0);

  const killed = bossDoc.status === "defeated";
  const rwd = rewardsCfg();
  const totalPool = Math.floor(bossDoc.max_hp * (rwd.poolRatio ?? 0.5));

  const payouts = ranking.map((r, idx) => {
    const share = totalDamage > 0 ? Math.floor(r.damage / totalDamage * totalPool) : 0;
    const rareReward = idx < (rwd.topRareRewards ?? 3) ? 1 : 0;
    const killBonus = killed ? (rwd.killBonus ?? 100) : 0;
    return {
      ...r,
      rank: idx + 1,
      share,
      rareReward,
      killBonus,
    };
  });

  let killerBonus = 0;
  let killerRare = 0;
  if (killed && bossDoc.killer_user_id) {
    killerBonus = Math.floor(bossDoc.max_hp * (rwd.killerBonusRatio ?? 0.05));
    killerRare = rwd.killerRareReward ?? 1;
    const killerRow = payouts.find((p) => p.userId === bossDoc.killer_user_id);
    if (killerRow) {
      killerRow.killerBonus = killerBonus;
      killerRow.killerRare = killerRare;
    } else {
      payouts.push({
        userId: bossDoc.killer_user_id,
        username: logs.find((l) => l.user_id === bossDoc.killer_user_id)?.username || "",
        damage: 0,
        rank: payouts.length + 1,
        share: 0,
        rareReward: 0,
        killBonus: rwd.killBonus ?? 100,
        killerBonus,
        killerRare,
        counters: 0,
        attacks: attackByUser.get(bossDoc.killer_user_id) || 0,
      });
    }
  }

  // 被龍揍王：被反擊次數最多且 ≥3
  let punchingBag = null;
  const counterRanking = [...counterByUser.entries()]
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count);
  if (counterRanking[0] && counterRanking[0].count >= 3) {
    punchingBag = counterRanking[0].userId;
  }

  await client.bossEventsCollection.updateOne(
    { boss_id: bossDoc.boss_id },
    {
      $set: {
        status: killed ? "defeated" : "expired",
        settled_at: Date.now(),
        total_damage: totalDamage,
        participant_count: ranking.length,
      },
    },
  );

  return {
    bossDoc,
    killed,
    killerUserId: bossDoc.killer_user_id,
    payouts,
    totalDamage,
    totalPool,
    mvpUserId: payouts[0]?.userId || null,
    comboMvpUserId: bossDoc.combo?.combo_mvp || null,
    punchingBagUserId: punchingBag,
    killerBonus,
    killerRare,
  };
}

async function findExpiredActiveBosses(client, now = Date.now()) {
  if (!client.bossEventsCollection) return [];
  return client.bossEventsCollection
    .find({ status: "active", ends_at: { $lte: now } })
    .toArray();
}

async function findFreshlyDefeatedBosses(client) {
  if (!client.bossEventsCollection) return [];
  return client.bossEventsCollection
    .find({ status: "defeated", settled_at: { $exists: false } })
    .toArray();
}

async function incrementKillCount(client, { userId, guildId }) {
  if (!client.bossKillsCollection) return 0;
  const res = await client.bossKillsCollection.findOneAndUpdate(
    { user_id: userId, guild_id: guildId },
    { $inc: { kills: 1 }, $set: { updatedAt: new Date() } },
    { upsert: true, returnDocument: "after" },
  );
  const doc = res?.value || res;
  return doc?.kills ?? 1;
}

module.exports = {
  cfg,
  spawnBoss,
  applyAttack,
  settleBoss,
  getActiveBoss,
  getBossInfo,
  findExpiredActiveBosses,
  findFreshlyDefeatedBosses,
  incrementKillCount,
  countOnlineMembers,
  phaseOf,
  phaseDef,
};
