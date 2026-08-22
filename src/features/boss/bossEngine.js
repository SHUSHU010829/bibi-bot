require("colors");
const { boss, serverId } = require("../../config");
const buffResolver = require("../buff/buffResolver");
const cook = require("../fishing/cookService");
const { getOrCreate } = require("../mining/miningProfile");
const { resolveStamina, staminaMax, getMemberClub, playerAtk } = require("../mining/dungeonService");
const grantActivityXp = require("../leveling/grantActivityXp");
const bossSkills = require("./bossSkills");
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

// 參加獎依「本場造成的傷害」分檔：出手就有底檔，打越痛檔位越高（金幣 / 經驗 / 碎片 / 鑽石一起加碼）。
// 取所有符合門檻中最高的一檔，config 順序不影響結果。
function participationTier(damage) {
  const tiers = rewardsCfg().participation?.tiers || [];
  let best = null;
  for (const t of tiers) {
    const min = t.minDamage ?? 0;
    if (damage >= min && (!best || min > (best.minDamage ?? 0))) best = t;
  }
  return best;
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

// 反擊率 = 階段基礎 + 怒氣加成 + 技能加成（暴風亂舞）+ 額外加成（嘲諷），上限 maxCounterRate。
// engine 與 view 共用。
function effectiveCounterRate(bossDoc, extraBonus = 0) {
  const phaseName = bossDoc.phase || phaseOf(bossDoc.current_hp, bossDoc.max_hp);
  const phase = phaseDef(phaseName);
  return Math.min(
    rageCfg().maxCounterRate ?? 0.5,
    (phase.counterRate ?? 0.1)
      + rageState(bossDoc).counterBonus
      + bossSkills.combinedEffects(bossDoc).counterBonus
      + (extraBonus || 0),
  );
}

// 線上人數只在有開 GuildPresences（privileged intent）時才拿得到；沒開的話 presence 恆為
// undefined，這裡會回 0。血量因此不能只靠它，見 expectedParticipants()。
function countOnlineMembers(client) {
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

function participantsCfg() {
  return cfg().participants || {};
}

// 過去幾場真的有多少人出手（settleBoss 寫下的 participant_count）——這是「會來打」的地面真相，
// 比線上人數 / 近期活躍人數都準，而且每打一場就自動校正一次。
async function recentParticipantAvg(client, guildId) {
  if (!client.bossEventsCollection) return 0;
  const n = participantsCfg().historySpawns ?? 5;
  const docs = await client.bossEventsCollection
    .find({ guild_id: guildId, participant_count: { $gt: 0 } })
    .sort({ started_at: -1 })
    .limit(n)
    .toArray()
    .catch(() => []);
  if (!docs.length) return 0;
  return docs.reduce((s, d) => s + (d.participant_count || 0), 0) / docs.length;
}

// 血量基準人數：優先用歷史參戰人數，還沒有戰績時才退回「近期活躍玩家 × 參戰率」與線上人數。
async function expectedParticipants(client, guildId, activeCount) {
  const p = participantsCfg();
  const online = countOnlineMembers(client);
  const history = await recentParticipantAvg(client, guildId);
  const fromActive = (activeCount || 0) * (p.activeParticipationRatio ?? 0.45);
  const raw = history > 0 ? history : Math.max(fromActive, online);
  const count = Math.min(p.max ?? 45, Math.max(p.min ?? 6, Math.round(raw)));
  return { count, history, fromActive, online, source: history > 0 ? "history" : "active" };
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

// 每人本場基礎出刀數。週六固定場血量另外吃 saturdaySpawn.hpMult，出刀數就得跟著獨立調，
// 否則血量翻倍、可用刀數沒變 = 一定打不完；招喚場（血量倍率 1）維持全域值。
function baseAttackLimitFor(bossDoc) {
  if (bossDoc?.spawn_source === "summon") return cfg().attackLimitPerPlayer ?? 5;
  return cfg().saturdaySpawn?.attackLimitPerPlayer ?? cfg().attackLimitPerPlayer ?? 5;
}

async function getActiveBoss(client, guildId) {
  if (!client.bossEventsCollection) return null;
  return client.bossEventsCollection.findOne({ guild_id: guildId, status: "active" });
}

// 魔王結束時間（防連續出場冷卻用）：存在 BossSummonState.last_boss_ended_at。
async function markBossEnded(client, guildId, when = Date.now()) {
  if (!client.bossSummonStateCollection || !guildId) return;
  await client.bossSummonStateCollection.updateOne(
    { guild_id: guildId },
    { $set: { last_boss_ended_at: when, updated_at: new Date() } },
    { upsert: true },
  ).catch(() => {});
}

// 距離上一隻魔王結束是否還在冷卻中；回傳 { onCooldown, until }。
async function bossCooldown(client, guildId, cooldownMs) {
  if (!cooldownMs || cooldownMs <= 0 || !client.bossSummonStateCollection) {
    return { onCooldown: false, until: 0 };
  }
  const state = await client.bossSummonStateCollection.findOne({ guild_id: guildId }).catch(() => null);
  const last = state?.last_boss_ended_at || 0;
  const until = last + cooldownMs;
  return { onCooldown: Date.now() < until, until };
}

// 依預估參戰人數 + 社群平均戰力即時算出魔王血量。hpMult 給招喚場調整血量倍率用。
async function computeScaledHp(client, guildId, hpMult = 1) {
  const stats = await activePlayerStats(client, guildId);
  const participants = await expectedParticipants(client, guildId, stats.activeCount);
  const base = participants.count * (cfg().hpPerPlayer ?? 500);
  let gearMult = 1;
  let scaling = null;
  if (cfg().scaling?.enabled) {
    gearMult = gearMultiplier(stats.avgAtk);
    scaling = {
      active_count: stats.activeCount,
      avg_atk: Math.round(stats.avgAtk),
      gear_mult: Number(gearMult.toFixed(2)),
      participant_basis: participants.count,
      participant_source: participants.source,
      history_avg: Number(participants.history.toFixed(1)),
    };
  }
  // minHp 是「最終血量」的下限，不是基數的下限——人少的場次就維持原本的保底血量，
  // 不會再被裝備倍率乘上去而變得比以前硬。
  const scaled = Math.max(cfg().minHp ?? 3000, base * gearMult);
  return {
    onlineCount: participants.online,
    participantBasis: participants.count,
    scaling,
    finalHp: Math.round(scaled * hpMult),
  };
}

function freshCombatFields() {
  return {
    killer_user_id: null,
    first_striker: null,
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
}

// hpMult：招喚場血量倍率；noExpiry：招喚場無時間限制（ends_at=null，待到被擊殺為止）。
async function spawnBoss(client, { guildId, name, emoji, hp, durationMs, spawnSource, hpMult, noExpiry }) {
  const now = Date.now();
  const existing = await getActiveBoss(client, guildId);
  if (existing) return { ok: false, reason: "already_active", boss: existing };

  let onlineCount = null;
  let participantBasis = null;
  let scaling = null;
  let finalHp;
  if (hp != null) {
    finalHp = hp;
  } else {
    ({ onlineCount, participantBasis, scaling, finalHp } = await computeScaledHp(client, guildId, hpMult ?? 1));
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
    ends_at: noExpiry ? null : now + duration,
    online_count: onlineCount ?? null,
    participant_basis: participantBasis ?? null,
    last_hit_at: now,
    spawn_source: spawnSource || "scheduled",
    scaling,
    ...bossSkills.initialState(now),
    ...freshCombatFields(),
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

// opts.skipCooldown：連擊（/魔王 攻擊 次數:N）的第 2 刀起沿用同一次開打，冷卻改成一次累計 N 刀，
// 不在刀與刀之間攔截。
async function applyAttack(client, { userId, guildId, username, member }, opts = {}) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_active" };
  const now = Date.now();
  // ends_at 為 null＝招喚場無時間限制，待到被擊殺為止；只有設了到期時間的場才會過期。
  if (bossDoc.ends_at != null && now >= bossDoc.ends_at) return { ok: false, reason: "expired" };

  const profile = await getOrCreate(client, userId, guildId);
  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);

  // 公會 buff 預讀（攻擊上限會吃 boss_attack_limit_bonus）
  const sum = await buffResolver.summary(client, userId, guildId, member).catch(() => null);
  const guildBossAtkPct = sum?.guildClub?.bossAtkBonus || 0;
  const guildAttackLimitBonus = sum?.guildClub?.bossAttackLimitBonus || 0;
  // 訓練場 boss_damage_pct（整數百分比）— 與既有 bossAtkPct 並存疊加
  const guildBossDmgPct = sum?.guildClub?.bossDamagePct || 0;

  // 個人「攻擊庫存」：平時打地下城累積（存 profile，可事先備戰、跨場使用），
  // 每一場魔王（含週六固定場）最多動用 maxBonusAttacksPerPlayer 次；超過基礎額度才扣庫存。
  // 上限以「本場開打時的庫存」為準（= 現有庫存 + 本場已花掉的），避免邊扣邊縮上限而卡住剩餘庫存。
  // 封魔彈藥：本場已啟用的話，攻擊次數與傷害都吃加成。
  // 標記存在 BossEvents doc 上，戰鬥結束整份 doc 失效，不需要另外清欄位。
  const ammoCfg = cfg().sealingAmmo || {};
  const ammo = ammoStateOf(profile, bossDoc, userId);
  const ammoActive = ammo.active;
  const ammoLimitBonus = ammoActive ? (ammoCfg.attackLimitBonus || 0) : 0;

  const baseLimit = baseAttackLimitFor(bossDoc) + guildAttackLimitBonus + ammoLimitBonus;
  const chargeCap = cfg().summon?.maxBonusAttacksPerPlayer ?? 5;
  const used = (bossDoc.attack_counts || {})[userId] || 0;
  const extraUsed = Math.max(0, used - baseLimit);
  const charges = Math.max(0, profile.boss_attack_charges || 0);
  const allowedExtra = Math.min(chargeCap, charges + extraUsed);
  const attackLimit = baseLimit + allowedExtra;
  if (used >= attackLimit) {
    return { ok: false, reason: "attack_limit", used, limit: attackLimit, ammo };
  }

  // 出刀冷卻：一場魔王不再是「開場三分鐘全員梭哈」，每個人的刀被攤到整場戰鬥裡。
  // 累加式（前一次到期時間 + 冷卻）讓連擊 N 刀 = 一次扣掉 N 份冷卻。
  const cdMs = (cfg().attackCooldownSec ?? 0) * 1000;
  const cooldownUntil = (bossDoc.cooldown_until || {})[userId] || 0;
  if (cdMs > 0 && !opts.skipCooldown && now < cooldownUntil) {
    return {
      ok: false,
      reason: "attack_cooldown",
      nextAt: cooldownUntil,
      cooldownSec: cfg().attackCooldownSec,
      used,
      limit: attackLimit,
      ammo,
    };
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
  const skillFx = bossSkills.combinedEffects(bossDoc, now);
  const finalStandMult = bossSkills.finalStandMult(bossDoc, now);
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
  const atk = sum?.atk ?? (await buffResolver.getEffectiveAtk(client, userId, guildId));
  const luck = sum?.luckBonus ?? 0;
  let damage = 0;
  let isCrit = false;
  if (!isCounter) {
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
    const buildingMult = 1 + (guildBossDmgPct + (ammoActive ? ammoCfg.bossDamagePct || 0 : 0)) / 100;
    // 會心一擊：幸運越高機率越高，命中則傷害倍增（厄運詛咒期間整場禁會心）。
    const crit = critCfg();
    if (crit.enabled && !skillFx.disableCrit) {
      const critRate = Math.min(
        crit.maxRate ?? 0.5,
        (crit.baseRate ?? 0.1) + luck * (crit.luckRateMult ?? 0),
      );
      isCrit = Math.random() < critRate;
    }
    const critMult = isCrit ? (crit.damageMult ?? 2) : 1;
    // 技能倍率與決戰倍率放最後：岩甲 ×0.45 / 詛咒 ×0.8 / 核心外露 ×2 / 決戰 ×1.4～×2
    // 都吃在最終傷害上。
    damage = Math.max(1, Math.floor(
      base * (phase.damageMult ?? 1) * streakMult * comboMult * guildMult * buildingMult * critMult
        * skillFx.damageTakenMult * finalStandMult,
    ));
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
  // 被反擊＝空刀，只扣體力：不佔本場攻擊次數，也不吃攻擊庫存。
  if (!isCounter && used >= baseLimit) {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId, boss_attack_charges: { $gt: 0 } },
      { $inc: { boss_attack_charges: -1 } },
    ).catch(() => {});
  }

  // BOSS 血量扣除 + 階段更新
  // 原子扣血：只在 boss 仍存活時生效，避免兩人同時讀到舊血量、各自算出「最後一擊」。
  const incFields = { current_hp: -damage, hits_taken: 1 };
  if (damage > 0) incFields[`damage_by_user.${userId}`] = damage;
  const attackCount = isCounter ? used : used + 1;
  const setFields = {
    "combo.count": comboCount,
    "combo.last_user": comboLastUser,
    "combo.last_ts": comboLastTs,
    "combo.same_user_streak": sameUserStreak,
    "combo.active_until": comboActiveUntil,
    "combo.combo_mvp": comboMvp,
    last_hit_at: now,
    updatedAt: new Date(),
  };
  if (!isCounter) setFields[`attack_counts.${userId}`] = attackCount;
  // 被反擊的空刀不佔次數，但一樣要進冷卻（否則被反擊就能無限重試）。
  const nextCooldownAt = cdMs > 0 ? Math.max(now, cooldownUntil) + cdMs : 0;
  if (cdMs > 0) setFields[`cooldown_until.${userId}`] = nextCooldownAt;
  const afterRes = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active" },
    {
      $inc: incFields,
      $set: setFields,
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

  // 岩甲類技能：全場合力累積到 breakHits 就提前打碎，由打出那一刀的人拿到公告。
  const breakable = bossSkills.pendingBreak(afterDoc, now);
  const skillBroken = breakable ? await bossSkills.breakSkill(client, afterDoc, breakable) : null;
  const skillsAfter = skillBroken
    ? (afterDoc.active_skills || []).filter((s) => s.started_at !== breakable.started_at)
    : (afterDoc.active_skills || []);

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

  // 命中即給活動經驗（被反擊的空刀不給）。攻擊次數本身有上限，天生防刷。
  let xpGained = 0;
  if (!isCounter && damage > 0) {
    xpGained = await grantActivityXp(client, "boss", {
      userId,
      guildId,
      username,
      member,
      meta: { boss_id: bossDoc.boss_id },
    });
  }

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
    xpGained,
    boss: {
      ...bossDoc,
      current_hp: newHp,
      phase: newPhase,
      hits_taken: afterDoc.hits_taken,
      active_skills: skillsAfter,
    },
    skillBroken,
    skillLabels: bossSkills.statusLines({ active_skills: skillsAfter }, now),
    cooldownUntil: nextCooldownAt,
    stamina: newStamina,
    staminaMax: max,
    myDamage: afterDoc.damage_by_user?.[userId] || 0,
    attackCount,
    attackLimit,
    ammo,
    bonusAttacks: allowedExtra,
    rageStacks: rageState({ hits_taken: afterDoc.hits_taken }).stacks,
    counterRate,
    firstStrike,
    buffInfo: {
      atk,
      luckBonus: luck,
      foodBuffs: cook.getActiveFoodBuffs(profile).map((b) => cook.describeFoodBuff(b)),
      bossAtkPct: guildBossAtkPct,
      bossDmgPct: guildBossDmgPct,
      comboActive: now < comboActiveUntil,
      ammoActive,
    },
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
  // 出過手就算參戰（含整場都被反擊的空刀玩家），這樣參加獎才不會漏人。
  const ranking = [...attackByUser.keys()]
    .map((userId) => ({
      userId,
      damage: dmgByUser.get(userId) || 0,
      counters: counterByUser.get(userId) || 0,
      attacks: attackByUser.get(userId) || 0,
      username: logs.find((x) => x.user_id === userId)?.username || "",
    }))
    .sort((a, b) => b.damage - a.damage);
  const totalDamage = ranking.reduce((s, r) => s + r.damage, 0);

  const killed = bossDoc.status === "defeated";
  // BOSS 逃離（時間到卻沒被擊殺）＝討伐失敗，只剩參加獎；戰報仍保留供回顧。
  // （招喚場不限時間，只會以「擊殺」結束，所以實際上都是有獎的。）
  const rewarded = killed;
  const rwd = rewardsCfg();
  const totalPool = rewarded ? Math.floor(bossDoc.max_hp * (rwd.poolRatio ?? 0.5)) : 0;
  const tiers = Array.isArray(rwd.topRareRewardTiers)
    ? rwd.topRareRewardTiers
    : new Array(rwd.topRareRewards ?? 3).fill(1);
  const diamondTiers = Array.isArray(rwd.topRankDiamondTiers) ? rwd.topRankDiamondTiers : [];

  const payouts = ranking.map((r, idx) => {
    const share = rewarded && totalDamage > 0 ? Math.floor(r.damage / totalDamage * totalPool) : 0;
    const rareReward = rewarded && r.damage > 0 ? (tiers[idx] || 0) : 0;
    const diamondReward = rewarded && r.damage > 0 ? (diamondTiers[idx] || 0) : 0;
    const killBonus = killed && r.damage > 0 ? (rwd.killBonus ?? 100) : 0;
    return {
      ...r,
      rank: idx + 1,
      share,
      rareReward,
      diamondReward,
      killBonus,
      participation: participationTier(r.damage),
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
        participation: participationTier(0),
        killerBonus,
        killerRare,
        counters: 0,
        attacks: attackByUser.get(bossDoc.killer_user_id) || 0,
      });
    }
  }

  // 首刀獎勵：頒給第一個對 boss 造成傷害的人（只有擊殺才發）。
  let firstStrikeBonus = 0;
  const firstStrikerUserId = rewarded ? (bossDoc.first_striker || null) : null;
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
          participation: participationTier(0),
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

  // 記錄結束時間 → 防「連續出場」冷卻。
  await markBossEnded(client, bossDoc.guild_id);

  return {
    bossDoc,
    killed,
    rewarded,
    killerUserId: bossDoc.killer_user_id,
    payouts,
    totalDamage,
    totalPool,
    mvpUserId: rewarded ? (payouts[0]?.userId || null) : null,
    comboMvpUserId: rewarded ? (bossDoc.combo?.combo_mvp || null) : null,
    punchingBagUserId: rewarded ? punchingBag : null,
    killerBonus,
    killerRare,
    firstStrikerUserId,
    firstStrikeBonus,
  };
}

async function findExpiredActiveBosses(client, now = Date.now()) {
  if (!client.bossEventsCollection) return [];
  // 只掃有設到期時間的場（ends_at 為數字）；招喚場 ends_at=null（無時限）不會被掃到。
  return client.bossEventsCollection
    .find({ status: "active", ends_at: { $type: "number", $lte: now } })
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
  const skillsBroken = [];

  for (let i = 0; i < count; i++) {
    // 冷卻只在第一刀擋；之後的刀屬於同一次連擊，冷卻在結束時一次累計 N 份。
    const r = await applyAttack(client, params, { skipCooldown: i > 0 });
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
        skillsBroken,
      };
    }
    hits.push(r);
    lastOkResult = r;
    if (r.phaseChanged) phaseChanged = true;
    if (r.comboTriggered) comboTriggered = true;
    if (r.skillBroken) skillsBroken.push(r.skillBroken);
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
    skillsBroken,
  };
}

// 封魔彈藥狀態：庫存存在 profile（跨場保留、無期限），本場是否已投入看 BossEvents 的 ammo_users。
function ammoStateOf(profile, bossDoc, userId) {
  return {
    enabled: !!(cfg().sealingAmmo || {}).enabled,
    count: profile?.sealing_ammo_count || 0,
    active: !!(bossDoc?.ammo_users || {})[userId],
  };
}

// 不經過攻擊流程時（戰況面板、按鈕失敗訊息）取得彈藥狀態。
async function sealingAmmoState(client, { userId, guildId }) {
  const bossDoc = await getActiveBoss(client, guildId);
  const profile = await getOrCreate(client, userId, guildId);
  return ammoStateOf(profile, bossDoc, userId);
}

// 對本場魔王啟用封魔彈藥：扣 1 個庫存並在 BossEvents doc 上標記。
// 單場限用 1 個 —— 用 ammo_users.<userId> 不存在當條件，兩邊都原子。
async function useSealingAmmo(client, { userId, guildId }) {
  const acfg = cfg().sealingAmmo || {};
  if (!acfg.enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_boss" };
  if ((bossDoc.ammo_users || {})[userId]) return { ok: false, reason: "already_used" };

  const dec = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId, sealing_ammo_count: { $gte: 1 } },
    { $inc: { sealing_ammo_count: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const decDoc = dec?.value || dec;
  if (!decDoc) return { ok: false, reason: "no_ammo" };

  const upd = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, [`ammo_users.${userId}`]: { $exists: false } },
    { $set: { [`ammo_users.${userId}`]: true } },
    { returnDocument: "after" },
  );
  if (!(upd?.value || upd)) {
    await client.miningProfilesCollection
      .updateOne({ userId, guildId }, { $inc: { sealing_ammo_count: 1 } })
      .catch(() => {});
    return { ok: false, reason: "already_used" };
  }

  return {
    ok: true,
    bossDamagePct: acfg.bossDamagePct || 0,
    attackLimitBonus: acfg.attackLimitBonus || 0,
    boss: bossDoc,
    countAfter: Math.max(0, decDoc.sealing_ammo_count || 0),
  };
}

module.exports = {
  useSealingAmmo,
  sealingAmmoState,
  cfg,
  spawnBoss,
  markBossEnded,
  bossCooldown,
  applyAttack,
  applyComboAttack,
  settleBoss,
  getActiveBoss,
  getBossInfo,
  findExpiredActiveBosses,
  findFreshlyDefeatedBosses,
  countOnlineMembers,
  expectedParticipants,
  computeScaledHp,
  phaseOf,
  phaseDef,
  participationTier,
  rageState,
  effectiveCounterRate,
  baseAttackLimitFor,
};
