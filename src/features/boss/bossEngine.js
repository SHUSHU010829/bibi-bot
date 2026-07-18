require("colors");
const { boss, serverId } = require("../../config");
const buffResolver = require("../buff/buffResolver");
const { getOrCreate } = require("../mining/miningProfile");
const { resolveStamina, staminaMax, getMemberClub, playerAtk } = require("../mining/dungeonService");
const bus = require("../eventBus");

function cfg() {
  return boss || {};
}

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pickFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomBoss() {
  const g = cfg().nameGenerator || {};
  const prefix = pickFrom(g.prefixes) || "";
  const core = pickFrom(g.cores) || "巨龍";
  const suffix = pickFrom(g.suffixes) || "";
  return {
    name: `${prefix}${core}${suffix}`,
    emoji: pickFrom(g.emojis) || "🐉",
  };
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

function rageCfg() {
  return cfg().rage || {};
}

function critCfg() {
  return cfg().crit || {};
}

function aggroCfg() {
  return cfg().aggro || {};
}

// 目前累積傷害最高的玩家（嘲諷/仇恨用）。damage_by_user 存於 boss doc，攻擊當下即時判定。
function topDamageUser(map) {
  let best = null;
  let bestVal = -1;
  for (const [uid, v] of Object.entries(map || {})) {
    if (v > bestVal) {
      bestVal = v;
      best = uid;
    }
  }
  return best;
}

// 魔王怒氣：被攻擊次數越多，反擊率越高（戰鬥中「越打越兇」）。
// 存來源（hits_taken），反擊率在攻擊當下即時換算，不寫死。
function rageState(bossDoc) {
  const rc = rageCfg();
  if (!rc.enabled) return { stacks: 0, counterBonus: 0 };
  const per = rc.hitsPerStack ?? 15;
  const stacks = Math.floor((bossDoc?.hits_taken || 0) / per);
  const counterBonus = stacks * (rc.counterRatePerStack ?? 0.03);
  return { stacks, counterBonus };
}

// 反擊率 = 階段基礎 + 怒氣加成 + 額外加成（嘲諷），上限 maxCounterRate。engine 與 view 共用。
function effectiveCounterRate(bossDoc, extraBonus = 0) {
  const phaseName = bossDoc.phase || phaseOf(bossDoc.current_hp, bossDoc.max_hp);
  const phase = phaseDef(phaseName);
  return Math.min(
    rageCfg().maxCounterRate ?? 0.5,
    (phase.counterRate ?? 0.1) + rageState(bossDoc).counterBonus + (extraBonus || 0),
  );
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

// 近期活躍玩家的裝備戰力（用來讓魔王隨玩家資源成長）。
async function activePlayerStats(client, guildId) {
  if (!client.miningProfilesCollection) return { activeCount: 0, totalAtk: 0, avgAtk: 0 };
  const days = cfg().scaling?.activeWithinDays ?? 14;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const profiles = await client.miningProfilesCollection
    .find({ guildId, updatedAt: { $gte: cutoff } })
    .toArray()
    .catch(() => []);
  let totalAtk = 0;
  for (const p of profiles) totalAtk += playerAtk(p);
  const activeCount = profiles.length;
  return { activeCount, totalAtk, avgAtk: activeCount ? totalAtk / activeCount : 0 };
}

// 依「社群平均戰力」換算魔王強化倍率：裝備越好，魔王血量越高。
function gearMultiplier(avgAtk) {
  const s = cfg().scaling || {};
  const baseAtk = s.baseAtk ?? 20;
  const step = s.atkPerGearStep ?? 60;
  const bonusPerStep = s.hpBonusPerStep ?? 0.15;
  const maxMult = s.maxGearMultiplier ?? 2.5;
  const steps = Math.max(0, (avgAtk - baseAtk) / step);
  return Math.min(maxMult, 1 + steps * bonusPerStep);
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
  let scaling = null;
  let finalHp;
  if (hp != null) {
    finalHp = hp;
  } else {
    const base = Math.max(cfg().minHp ?? 3000, onlineCount * (cfg().hpPerPlayer ?? 500));
    let gearMult = 1;
    if (cfg().scaling?.enabled) {
      const stats = await activePlayerStats(client, guildId);
      gearMult = gearMultiplier(stats.avgAtk);
      scaling = {
        active_count: stats.activeCount,
        avg_atk: Math.round(stats.avgAtk),
        gear_mult: Number(gearMult.toFixed(2)),
      };
    }
    finalHp = Math.round(base * gearMult);
  }
  const duration = durationMs ?? (cfg().durationMinutes ?? 30) * 60 * 1000;
  const bossId = `boss_${guildId}_${now}`;

  const generated = (name && emoji) ? null : generateRandomBoss();

  const doc = {
    boss_id: bossId,
    guild_id: guildId,
    name: name || generated?.name || cfg().saturdaySpawn?.name || "巨龍",
    emoji: emoji || generated?.emoji || cfg().saturdaySpawn?.emoji || "🐉",
    max_hp: finalHp,
    current_hp: finalHp,
    phase: "normal",
    status: "active",
    started_at: now,
    ends_at: now + duration,
    killer_user_id: null,
    first_striker: null,
    online_count: onlineCount ?? null,
    scaling,
    hits_taken: 0,
    damage_by_user: {},
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

  const profile = await getOrCreate(client, userId, guildId);
  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);

  // 公會 buff 預讀（攻擊上限會吃 boss_attack_limit_bonus）
  const sum = await buffResolver.summary(client, userId, guildId, member).catch(() => null);
  const guildBossAtkPct = sum?.guildClub?.bossAtkBonus || 0;
  const guildAttackLimitBonus = sum?.guildClub?.bossAttackLimitBonus || 0;
  // 訓練場 boss_damage_pct（整數百分比）— 與既有 bossAtkPct 並存疊加
  const guildBossDmgPct = sum?.guildClub?.bossDamagePct || 0;

  const attackLimit = (cfg().attackLimitPerPlayer ?? 5) + guildAttackLimitBonus;
  const used = (bossDoc.attack_counts || {})[userId] || 0;
  if (used >= attackLimit) {
    return { ok: false, reason: "attack_limit", used, limit: attackLimit };
  }
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

  // 嘲諷/仇恨：當前傷害王被魔王盯上，對他的反擊率額外提高。
  const aggro = aggroCfg();
  const dmgByUser = bossDoc.damage_by_user || {};
  const leaderId = topDamageUser(dmgByUser);
  const participants = Object.keys(dmgByUser).length;
  const isTargeted = !!(
    aggro.enabled
    && leaderId
    && leaderId === userId
    && participants >= (aggro.minParticipants ?? 2)
  );
  const aggroBonus = isTargeted ? (aggro.counterBonus ?? 0) : 0;
  const counterRate = effectiveCounterRate(bossDoc, aggroBonus);
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
    const isNewUser = !comboLastUser || userId !== comboLastUser;
    if (comboLastUser && isNewUser && now - comboLastTs <= windowMs) {
      comboCount += 1;
    } else if (isNewUser) {
      comboCount = 1;
    }
    if (comboCount >= (comboCfgVal.triggerCount ?? 5)) {
      comboTriggered = true;
      comboActiveUntil = now + (comboCfgVal.durationSec ?? 120) * 1000;
      // 開團王＝「第一個把 Combo 帶滿的人」，之後再次觸發不覆蓋。
      if (!comboMvp) comboMvp = userId;
      comboCount = 0;
    }
    // 同一人連砍不 refresh combo window，避免延長計時、卡住他人接力空間
    if (isNewUser) {
      comboLastUser = userId;
      comboLastTs = now;
    }
  }

  // 傷害計算
  let damage = 0;
  let isCrit = false;
  if (!isCounter) {
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
    const guildMult = 1 + guildBossAtkPct;
    const buildingMult = 1 + guildBossDmgPct / 100;
    // 會心一擊：幸運越高機率越高，命中則傷害倍增。
    const crit = critCfg();
    if (crit.enabled) {
      const critRate = Math.min(
        crit.maxRate ?? 0.5,
        (crit.baseRate ?? 0.1) + luck * (crit.luckRateMult ?? 0),
      );
      isCrit = Math.random() < critRate;
    }
    const critMult = isCrit ? (crit.damageMult ?? 2) : 1;
    damage = Math.max(1, Math.floor(base * (phase.damageMult ?? 1) * streakMult * comboMult * guildMult * buildingMult * critMult));
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
  // 原子扣血：只在 boss 仍存活時生效，避免兩人同時讀到舊血量、各自算出「最後一擊」。
  const incFields = { current_hp: -damage, hits_taken: 1 };
  if (damage > 0) incFields[`damage_by_user.${userId}`] = damage;
  const afterRes = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active" },
    {
      $inc: incFields,
      $set: {
        "combo.count": comboCount,
        "combo.last_user": comboLastUser,
        "combo.last_ts": comboLastTs,
        "combo.same_user_streak": sameUserStreak,
        "combo.active_until": comboActiveUntil,
        "combo.combo_mvp": comboMvp,
        [`attack_counts.${userId}`]: used + 1,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  const afterDoc = afterRes?.value || afterRes;
  // 期間 boss 已被別人結束（擊殺 / 到期）→ 這刀不算數
  if (!afterDoc) return { ok: false, reason: "expired" };

  // 首刀：第一個造成傷害（非被反擊）的人，原子搶下 first_striker（只有第一人成功）。
  let firstStrike = false;
  if (!isCounter && !afterDoc.first_striker) {
    const res = await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, first_striker: null },
      { $set: { first_striker: userId } },
    );
    firstStrike = res.modifiedCount === 1;
  }

  const rawHp = afterDoc.current_hp ?? 0;
  const newHp = Math.max(0, rawHp);
  const newPhase = phaseOf(newHp, bossDoc.max_hp);
  const phaseChanged = newPhase !== bossDoc.phase;

  // 只有第一個把血量打到 0 的人能搶下擊殺（原子 status 轉移），其餘人只算普通命中。
  let killed = false;
  if (rawHp <= 0) {
    const claimRes = await client.bossEventsCollection.findOneAndUpdate(
      { boss_id: bossDoc.boss_id, status: "active" },
      { $set: { status: "defeated", killer_user_id: userId, killed_at: now, current_hp: 0, phase: newPhase } },
      { returnDocument: "after" },
    );
    killed = !!(claimRes?.value || claimRes);
  } else if (phaseChanged) {
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, status: "active" },
      { $set: { phase: newPhase } },
    );
  }

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

  bus.emit("boss.attacked", {
    userId,
    guildId,
    bossId: bossDoc.boss_id,
    damage,
    isCounter,
    phaseAfter: newPhase,
  });
  if (killed) {
    bus.emit("boss.killed", {
      userId,
      guildId,
      bossId: bossDoc.boss_id,
    });
  }

  return {
    ok: true,
    damage,
    isCounter,
    isCrit,
    targeted: isTargeted,
    critMult: critCfg().damageMult ?? 2,
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
    boss: { ...bossDoc, current_hp: newHp, phase: newPhase, hits_taken: afterDoc.hits_taken },
    stamina: newStamina,
    staminaMax: max,
    attackCount: used + 1,
    attackLimit,
    rageStacks: rageState({ hits_taken: afterDoc.hits_taken }).stacks,
    counterRate,
    firstStrike,
  };
}

async function settleBoss(client, bossDoc) {
  if (!bossDoc) return null;
  if (bossDoc.status !== "active" && bossDoc.status !== "defeated") return null;

  // 原子搶結算權：擊殺當下的結算與每分鐘掃描可能同時觸發，只讓第一個跑，避免重複發獎。
  const claimRes = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, settled_at: { $exists: false } },
    { $set: { settled_at: Date.now() } },
    { returnDocument: "after" },
  );
  if (!(claimRes?.value || claimRes)) return null;

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
  const tiers = Array.isArray(rwd.topRareRewardTiers)
    ? rwd.topRareRewardTiers
    : new Array(rwd.topRareRewards ?? 3).fill(1);
  const diamondTiers = Array.isArray(rwd.topRankDiamondTiers) ? rwd.topRankDiamondTiers : [];

  const payouts = ranking.map((r, idx) => {
    const share = totalDamage > 0 ? Math.floor(r.damage / totalDamage * totalPool) : 0;
    const rareReward = tiers[idx] || 0;
    const diamondReward = diamondTiers[idx] || 0;
    const killBonus = killed ? (rwd.killBonus ?? 100) : 0;
    return {
      ...r,
      rank: idx + 1,
      share,
      rareReward,
      diamondReward,
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

  // 首刀獎勵：頒給第一個對 boss 造成傷害的人。
  let firstStrikeBonus = 0;
  const firstStrikerUserId = bossDoc.first_striker || null;
  if (firstStrikerUserId) {
    firstStrikeBonus = rwd.firstStrikeBonus ?? 0;
    if (firstStrikeBonus > 0) {
      const row = payouts.find((p) => p.userId === firstStrikerUserId);
      if (row) {
        row.firstStrikeBonus = firstStrikeBonus;
      } else {
        payouts.push({
          userId: firstStrikerUserId,
          username: logs.find((l) => l.user_id === firstStrikerUserId)?.username || "",
          damage: 0,
          rank: payouts.length + 1,
          share: 0,
          rareReward: 0,
          killBonus: 0,
          firstStrikeBonus,
          counters: 0,
          attacks: attackByUser.get(firstStrikerUserId) || 0,
        });
      }
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
    firstStrikerUserId,
    firstStrikeBonus,
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

async function applyComboAttack(client, params, count) {
  const hits = [];
  let stopReason = null;
  let lastOkResult = null;
  let killed = false;
  let phaseChanged = false;
  let comboTriggered = false;

  for (let i = 0; i < count; i++) {
    const r = await applyAttack(client, params);
    if (!r.ok) {
      stopReason = r.reason;
      if (hits.length === 0) {
        return { ok: false, reason: r.reason, errorResult: r };
      }
      return {
        ok: true,
        hits,
        stopReason,
        lastResult: lastOkResult,
        killed,
        phaseChanged,
        comboTriggered,
      };
    }
    hits.push(r);
    lastOkResult = r;
    if (r.phaseChanged) phaseChanged = true;
    if (r.comboTriggered) comboTriggered = true;
    if (r.killed) {
      killed = true;
      stopReason = "killed";
      break;
    }
    if (r.stamina <= 0) {
      stopReason = "stamina_drained";
      break;
    }
    if (r.attackCount >= r.attackLimit) {
      stopReason = "attack_limit_reached";
      break;
    }
  }

  return {
    ok: true,
    hits,
    stopReason,
    lastResult: lastOkResult,
    killed,
    phaseChanged,
    comboTriggered,
  };
}

module.exports = {
  cfg,
  spawnBoss,
  applyAttack,
  applyComboAttack,
  settleBoss,
  getActiveBoss,
  getBossInfo,
  findExpiredActiveBosses,
  findFreshlyDefeatedBosses,
  countOnlineMembers,
  phaseOf,
  phaseDef,
  rageState,
  effectiveCounterRate,
};
