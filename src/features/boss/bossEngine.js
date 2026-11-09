require("colors");
const { boss, serverId } = require("../../config");
const buffResolver = require("../buff/buffResolver");
const cook = require("../fishing/cookService");
const { getOrCreate } = require("../mining/miningProfile");
const { resolveStamina, staminaMax, getMemberClub, playerAtk } = require("../mining/dungeonService");
const grantActivityXp = require("../leveling/grantActivityXp");
const bossSkills = require("./bossSkills");
const bossPlayerEvents = require("./bossPlayerEvents");
const bossBars = require("./bossBars");
const bossPlayerStats = require("./bossPlayerStats");
const grantCoins = require("../economy/grantCoins");
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

// 分段血條場依「打爆幾成血條」換階段（破防 / 狂暴跟著里程碑走）；單條血的舊場次照舊看血量比例。
function phaseOf(currentHp, maxHp, barsTotal = 1) {
  const phases = cfg().phases || {};
  if (barsTotal > 1) {
    const ratio = bossBars.brokenFromHp({ max_hp: maxHp, bars_total: barsTotal }, currentHp) / barsTotal;
    if (ratio >= (phases.enraged?.barRatio ?? 0.75)) return "enraged";
    if (ratio >= (phases.broken?.barRatio ?? 0.5)) return "broken";
    return "normal";
  }
  const ratio = maxHp > 0 ? currentHp / maxHp : 0;
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

// 反擊率 = 階段基礎 + 怒氣加成 + 打爆血條加成 + 技能加成（暴風亂舞）+ 額外加成（嘲諷），上限 maxCounterRate。
// engine 與 view 共用。
function effectiveCounterRate(bossDoc, extraBonus = 0) {
  const phaseName = bossDoc.phase || phaseOf(bossDoc.current_hp, bossDoc.max_hp, bossDoc.bars_total);
  const phase = phaseDef(phaseName);
  return Math.min(
    rageCfg().maxCounterRate ?? 0.5,
    (phase.counterRate ?? 0.1)
      + rageState(bossDoc).counterBonus
      + bossBars.counterBonus(bossDoc)
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

// 本場基礎額度＝出刀上限 + 公會 buff + 反攻號角回復的次數。攻擊與投彈都走這一份，
// 兩邊算法一分岔，回推「已花掉的攻擊庫存」就會多退少補。
function baseLimitFor(bossDoc, guildAttackLimitBonus = 0) {
  return baseAttackLimitFor(bossDoc) + guildAttackLimitBonus + bossSkills.rallyBonus(bossDoc);
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

function adaptiveCfg() {
  return cfg().adaptiveHp || {};
}

// 近幾場「每一刀平均打多少」（含被反擊的空刀與道具傷害，所以反擊率、道具使用率都自動算進去）。
async function recentDamagePerHit(client, guildId) {
  if (!client.bossEventsCollection) return { perHit: 0, samples: 0 };
  const docs = await client.bossEventsCollection
    .find({ guild_id: guildId, settled_at: { $exists: true }, total_damage: { $gt: 0 }, hits_taken: { $gt: 0 } })
    .sort({ started_at: -1 })
    .limit(adaptiveCfg().historySpawns ?? 5)
    .toArray()
    .catch(() => []);
  const dmg = docs.reduce((s, d) => s + (d.total_damage || 0), 0);
  const hits = docs.reduce((s, d) => s + (d.hits_taken || 0), 0);
  return { perHit: hits > 0 ? dmg / hits : 0, samples: docs.length };
}

// 難度比例：存在每場的 hp_ratio 上（存來源），下一場從上一場同類型的值接著調。
//   - 打太快（用時 < targetKillRatio）：小幅上調，差越多調越多，但每場最多 +maxStepUp——
//     連續幾場都打太快才會一路慢慢變硬，不會一場就跳一大截。
//   - 逃走：一次 −stepDown。打不完最傷士氣，所以往下要快、往上要慢。
//   - 用時在目標之後才打死、或沒有時限的場：維持不動。
async function nextHpRatio(client, guildId, spawnSource) {
  const a = adaptiveCfg();
  const base = a.targetRatio?.[spawnSource] ?? 1;
  const lo = base * (a.minAdjust ?? 0.7);
  const hi = base * (a.maxAdjust ?? 2);
  const last = client.bossEventsCollection
    ? await client.bossEventsCollection
      .find({ guild_id: guildId, spawn_source: spawnSource, settled_at: { $exists: true }, hp_ratio: { $type: "number" } })
      .sort({ started_at: -1 })
      .limit(1)
      .next()
      .catch(() => null)
    : null;
  const result = { ratio: base, change: 0, lastKillRatio: null, lastStatus: null, base, lo, hi };
  if (!last) return result;
  result.lastStatus = last.status;
  let change = 0;
  if (last.status === "expired") {
    change = -(a.stepDown ?? 0.1);
  } else if (last.status === "defeated" && last.ends_at != null && last.killed_at) {
    const used = (last.killed_at - last.started_at) / Math.max(1, last.ends_at - last.started_at);
    result.lastKillRatio = used;
    const gap = (a.targetKillRatio ?? 0.75) - used;
    if (gap > 0) change = Math.min(a.maxStepUp ?? 0.05, gap * (a.stepUpPerGap ?? 0.15));
  }
  const ratio = Math.min(hi, Math.max(lo, last.hp_ratio * (1 + change)));
  return { ...result, ratio, change: ratio / last.hp_ratio - 1, prevRatio: last.hp_ratio };
}

// 自適應血量，依資料多寡分兩段：
//   1. 個人戰績夠（BossPlayerStats 近期 ≥ minFights 場）：Σ 每位常客「出席率 × 近況每刀平均 × 出刀數」＋新面孔估計
//   2. 不夠：預估參戰人數 × 每人出刀數 × 近期全場每刀平均
// 兩段最後都乘難度比例（上一場逃走下調、速殺上調）。都沒有戰績時回 null，由呼叫端退回舊公式。
async function computeAdaptiveHp(client, guildId, spawnSource, participants) {
  const a = adaptiveCfg();
  if (!a.enabled) return null;
  const hits = baseAttackLimitFor({ spawn_source: spawnSource });
  const fc = await bossPlayerStats.forecast(client, guildId, spawnSource, hits).catch(() => null);
  if (fc && fc.expected > 0) {
    const adj = await nextHpRatio(client, guildId, spawnSource);
    const ratio = adj.ratio;
    return {
      adjust: adj,
      hp: fc.expected * ratio,
      ratio,
      info: {
        mode: "player_forecast",
        expected_damage: Math.round(fc.expected),
        newcomer_damage: Math.round(fc.newcomer),
        regulars: fc.players.length,
        sample_fights: fc.fights,
        sample_scope: fc.scope,
        hits_per_player: hits,
        hp_ratio: Number(ratio.toFixed(3)),
        participant_basis: participants.count,
        participant_source: participants.source,
        history_avg: Number(participants.history.toFixed(1)),
      },
    };
  }
  const { perHit, samples } = await recentDamagePerHit(client, guildId);
  if (samples < (a.minHistory ?? 2) || perHit <= 0) return null;
  const adj = await nextHpRatio(client, guildId, spawnSource);
  const ratio = adj.ratio;
  const hp = participants.count * hits * perHit * ratio;
  return {
    adjust: adj,
    hp,
    ratio,
    info: {
      mode: "adaptive",
      per_hit: Math.round(perHit),
      hits_per_player: hits,
      hp_ratio: Number(ratio.toFixed(3)),
      participant_basis: participants.count,
      participant_source: participants.source,
      history_avg: Number(participants.history.toFixed(1)),
    },
  };
}

// 依預估參戰人數 + 社群實際輸出即時算出魔王血量。hpMult 只在還沒有戰績、退回舊公式時才用。
async function computeScaledHp(client, guildId, hpMult = 1, spawnSource = "manual") {
  const stats = await activePlayerStats(client, guildId);
  const participants = await expectedParticipants(client, guildId, stats.activeCount);
  const adaptive = await computeAdaptiveHp(client, guildId, spawnSource, participants);
  if (adaptive) {
    return {
      onlineCount: participants.online,
      participantBasis: participants.count,
      scaling: adaptive.info,
      hpRatio: adaptive.ratio,
      adjust: adaptive.adjust,
      finalHp: Math.round(Math.max(cfg().minHp ?? 3000, adaptive.hp)),
    };
  }
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
    charge_counts: {},
    bars_broken: 0,
    bar_damage: {},
    bar_coins_by_user: {},
    bar_rare_by_user: {},
  };
}

// hpMult：招喚場血量倍率；noExpiry：不設到期時間（ends_at=null，待到被擊殺為止）。
async function spawnBoss(client, { guildId, name, emoji, hp, durationMs, spawnSource, hpMult, noExpiry }) {
  const now = Date.now();
  const existing = await getActiveBoss(client, guildId);
  if (existing) return { ok: false, reason: "already_active", boss: existing };

  let onlineCount = null;
  let participantBasis = null;
  let scaling = null;
  let hpRatio = null;
  let finalHp;
  const source = spawnSource || "scheduled";
  if (hp != null) {
    finalHp = hp;
  } else {
    ({ onlineCount, participantBasis, scaling, hpRatio, finalHp } = await computeScaledHp(client, guildId, hpMult ?? 1, source));
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
    spawn_source: source,
    scaling,
    hp_ratio: hpRatio ?? null,
    bars_total: bossBars.countFor(source),
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

async function applyAttack(client, { userId, guildId, username, member }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_active" };
  const now = Date.now();
  // ends_at 為 null＝無時限場，待到被擊殺為止；只有設了到期時間的場才會過期。
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

  // 出刀額度分三段，順序固定為 base → 攻擊庫存 → 封魔彈藥，彈藥的 +N 刀掛在最外層。
  // 「本場已花掉的庫存」必須實際記在 charge_counts，不能用 used - baseLimit 回推：
  // 回推的話彈藥 +N 一旦併進 baseLimit，已花掉的庫存就憑空少 N、額度被自己抵消，
  // 「原本次數打完才投彈」等於完全沒效果。
  const baseLimit = baseLimitFor(bossDoc, guildAttackLimitBonus);
  const chargeCap = cfg().summon?.maxBonusAttacksPerPlayer ?? 5;
  const used = (bossDoc.attack_counts || {})[userId] || 0;
  // 舊場次沒有 charge_counts 欄位時才回推（此時 base+彈藥 先用完才輪到庫存，與舊算法一致）。
  const recordedSpent = (bossDoc.charge_counts || {})[userId];
  const extraUsed = Math.min(
    chargeCap,
    Math.max(0, recordedSpent ?? (used - baseLimit - ammoLimitBonus)),
  );
  const charges = Math.max(0, profile.boss_attack_charges || 0);
  const allowedExtra = Math.min(chargeCap, charges + extraUsed);
  const attackLimit = baseLimit + allowedExtra + ammoLimitBonus;
  // 這一刀算庫存還是彈藥額度：base 用完後先吃庫存，庫存額度也用完才吃彈藥的 +N。
  const usesCharge = used - extraUsed >= baseLimit && extraUsed < allowedExtra;
  if (used >= attackLimit) {
    return { ok: false, reason: "attack_limit", used, limit: attackLimit, ammo };
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
  const phaseName = bossDoc.phase || phaseOf(bossDoc.current_hp, bossDoc.max_hp, bossDoc.bars_total);
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
  // 這名玩家身上還生效的攻擊事件效果（鐵壁架勢免疫反擊、戰吼增傷、專注必定會心）。
  const playerFx = bossPlayerEvents.effectsOf(bossDoc, userId, now);
  const counterRate = effectiveCounterRate(bossDoc, aggroBonus);
  const isCounter = !playerFx.counterImmune && Math.random() < counterRate;

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
      isCrit = playerFx.forceCrit || Math.random() < critRate;
    }
    const critMult = isCrit ? (crit.damageMult ?? 2) : 1;
    // 技能倍率與決戰倍率放最後：岩甲 ×0.45 / 詛咒 ×0.8 / 破條爆發 ×1.5 / 決戰 ×1.4～×2
    // 都吃在最終傷害上。
    damage = Math.max(1, Math.floor(
      base * (phase.damageMult ?? 1) * streakMult * comboMult * guildMult * buildingMult * critMult
        * skillFx.damageTakenMult * finalStandMult * playerFx.damageMult,
    ));
  }

  // 玩家攻擊事件：命中才擲。天降隕石這種一次性加傷要在扣血前併進這一刀，
  // 否則多打的傷害不算進擊殺判定。
  const eventDef = isCounter ? null : bossPlayerEvents.roll(bossDoc, userId, now);
  if (eventDef?.bonusDamageMult > 0) {
    damage = Math.max(1, Math.floor(damage * eventDef.bonusDamageMult));
  }
  const eventCoins = eventDef?.coinMax > 0 ? rand(eventDef.coinMin || 0, eventDef.coinMax) : 0;
  const eventStamina = eventDef?.staminaRestore || 0;
  const refundAttack = !!eventDef?.attackRefund;

  // 體力扣除
  const wasFull = st.stamina >= max;
  const newStamina = Math.max(0, Math.min(max, st.stamina - (isCounter ? 2 : 1) + eventStamina));
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
  if (!isCounter && usesCharge && !refundAttack) {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId, boss_attack_charges: { $gt: 0 } },
      { $inc: { boss_attack_charges: -1 } },
    ).catch(() => {});
  }

  // BOSS 血量扣除 + 階段更新
  // 原子扣血：只在 boss 仍存活時生效，避免兩人同時讀到舊血量、各自算出「最後一擊」。
  const incFields = { current_hp: -damage, hits_taken: 1 };
  if (damage > 0) {
    incFields[`damage_by_user.${userId}`] = damage;
    if (bossBars.enabledFor(bossDoc)) incFields[`bar_damage.${bossBars.barIndexForHit(bossDoc)}.${userId}`] = damage;
  }
  // 「再來一刀」事件：這刀不計入本場次數，也不吃攻擊庫存。
  const attackCount = isCounter || refundAttack ? used : used + 1;
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
  if (!isCounter) {
    setFields[`attack_counts.${userId}`] = attackCount;
    setFields[`charge_counts.${userId}`] = extraUsed + (usesCharge && !refundAttack ? 1 : 0);
  }
  // 事件的持續效果與個人冷卻跟著同一次原子更新寫進去，不另外打一次 DB。
  const fxEntry = eventDef ? bossPlayerEvents.fxEntry(eventDef, now) : null;
  if (eventDef) setFields[`event_cd.${userId}`] = now + bossPlayerEvents.cooldownMs();
  const updateOps = { $inc: incFields, $set: setFields };
  if (fxEntry) updateOps.$push = { [`player_fx.${userId}`]: fxEntry };
  const afterRes = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active" },
    updateOps,
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
  const newPhase = phaseOf(newHp, bossDoc.max_hp, bossDoc.bars_total);
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

  // 打爆血條：即時分獎勵池、掛破條爆發、每兩條吹反攻號角（全場出刀次數 +N）。
  const breaks = await bossBars.processBreaks(client, afterDoc, { breakerUserId: damage > 0 ? userId : null, now });
  const barEvents = breaks.events;
  const rallies = barEvents.filter((e) => e.type === "rally");
  const rally = rallies[rallies.length - 1] || null;
  const rallyBonusGained = rallies.reduce((s, e) => s + (e.bonus || 0), 0);
  const barsBrokenAfter = breaks.boss?.bars_broken ?? afterDoc.bars_broken ?? 0;
  const skillsAfterBars = barEvents.some((e) => e.type === "bar_break")
    ? (breaks.boss?.active_skills || skillsAfter).filter((s) => !skillBroken || s.started_at !== breakable.started_at)
    : skillsAfter;

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

  if (eventCoins > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      member,
      amount: eventCoins,
      source: "boss_event",
    }).catch(() => {});
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
      active_skills: skillsAfterBars,
      bars_broken: barsBrokenAfter,
      bar_damage: afterDoc.bar_damage,
    },
    skillBroken,
    skillLabels: bossSkills.statusLines({ active_skills: skillsAfterBars }, now),
    rally,
    barEvents,
    hitBarPct: bossBars.hitPctOfBar(bossDoc, damage),
    playerEvent: eventDef
      ? { def: eventDef, coins: eventCoins, stamina: eventStamina, refunded: refundAttack }
      : null,
    playerFxLabels: bossPlayerEvents.statusLines(afterDoc, userId, now),
    stamina: newStamina,
    staminaMax: max,
    myDamage: afterDoc.damage_by_user?.[userId] || 0,
    attackCount,
    attackLimit: attackLimit + rallyBonusGained,
    ammo,
    bonusAttacks: allowedExtra,
    ammoAttacks: ammoLimitBonus,
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
  // 分段血條場：獎勵池在每條血打爆的當下就分掉了（bar_coins_by_user），結算不再發一次；
  // 排名掉落依「打爆幾條」按比例發——逃走也拿得到已經打下來的那一份。
  // 擊殺專屬（擊殺紅利、尾刀、首刀、擊殺經驗、稱號、公會鎖定金）仍然只有打死才有。
  // 單條血的舊場次維持全有全無。
  const barMode = bossBars.enabledFor(bossDoc);
  const barsBroken = barMode ? Math.max(bossDoc.bars_broken || 0, bossBars.brokenFromHp(bossDoc)) : 0;
  const clearRatio = killed ? 1 : (barMode ? barsBroken / bossBars.totalOf(bossDoc) : 0);
  const rewarded = clearRatio > 0;
  const rwd = rewardsCfg();
  const fullPool = Math.floor(bossDoc.max_hp * (rwd.poolRatio ?? 0.5));
  const barCoins = bossDoc.bar_coins_by_user || {};
  const barRare = bossDoc.bar_rare_by_user || {};
  const totalPool = barMode
    ? Object.values(barCoins).reduce((sum, v) => sum + (v || 0), 0)
    : (killed ? fullPool : 0);
  const tiers = Array.isArray(rwd.topRareRewardTiers)
    ? rwd.topRareRewardTiers
    : new Array(rwd.topRareRewards ?? 3).fill(1);
  const diamondTiers = Array.isArray(rwd.topRankDiamondTiers) ? rwd.topRankDiamondTiers : [];
  const scaled = (n) => Math.floor((n || 0) * clearRatio);

  const payouts = ranking.map((r, idx) => {
    const share = !barMode && killed && totalDamage > 0 ? Math.floor(r.damage / totalDamage * totalPool) : 0;
    const rareReward = rewarded && r.damage > 0 ? scaled(tiers[idx]) : 0;
    const diamondReward = rewarded && r.damage > 0 ? scaled(diamondTiers[idx]) : 0;
    const killBonus = killed && r.damage > 0 ? (rwd.killBonus ?? 100) : 0;
    return {
      ...r,
      rank: idx + 1,
      share,
      barCoins: barCoins[r.userId] || 0,
      barRare: barRare[r.userId] || 0,
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
  const firstStrikerUserId = killed ? (bossDoc.first_striker || null) : null;
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

  await bossPlayerStats.recordFight(client, {
    bossDoc,
    ranking,
    logs,
    killed,
    barsBroken,
    attackLimit: baseLimitFor({ ...bossDoc, bars_broken: barsBroken }),
  });

  const grade = gradeOf({ killed, clearRatio, bossDoc });
  await client.bossEventsCollection.updateOne(
    { boss_id: bossDoc.boss_id },
    { $set: { grade: grade?.key || null, clear_ratio: Number(clearRatio.toFixed(3)), bars_broken: barsBroken } },
  ).catch(() => {});

  return {
    bossDoc,
    killed,
    rewarded,
    barMode,
    barsBroken,
    barsTotal: bossBars.totalOf(bossDoc),
    clearRatio,
    grade,
    killerUserId: bossDoc.killer_user_id,
    payouts,
    totalDamage,
    totalPool,
    mvpUserId: rewarded ? (payouts[0]?.userId || null) : null,
    comboMvpUserId: killed ? (bossDoc.combo?.combo_mvp || null) : null,
    punchingBagUserId: killed ? punchingBag : null,
    killerBonus,
    killerRare,
    firstStrikerUserId,
    firstStrikeBonus,
  };
}

// 討伐評價：S（擊殺且剩很多時間）/ A（擊殺）/ B、C、D（依打爆比例）。順序即判定優先序。
function gradeOf({ killed, clearRatio, bossDoc }) {
  const grades = Array.isArray(cfg().grades) ? cfg().grades : [];
  const remainMin = bossDoc.ends_at != null && bossDoc.killed_at
    ? (bossDoc.ends_at - bossDoc.killed_at) / 60000
    : null;
  for (const g of grades) {
    if (g.killed && !killed) continue;
    if (g.minRemainingMinutes != null && (remainMin == null || remainMin < g.minRemainingMinutes)) continue;
    if (g.minClearRatio != null && clearRatio < g.minClearRatio) continue;
    return g;
  }
  return null;
}

async function findExpiredActiveBosses(client, now = Date.now()) {
  if (!client.bossEventsCollection) return [];
  // 只掃有設到期時間的場（ends_at 為數字）；ends_at=null 的無時限場不會被掃到。
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

  // 投彈前先把「本場已花掉的攻擊庫存」落成實數（只補沒有欄位的舊場次）：
  // 少了這一步，投彈當下的額度會用 used - baseLimit 回推，彈藥的 +N 會被自己抵消掉。
  if (!(bossDoc.charge_counts || {})[userId]) {
    const sum = await buffResolver.summary(client, userId, guildId).catch(() => null);
    const guildAttackLimitBonus = sum?.guildClub?.bossAttackLimitBonus || 0;
    const usedNow = (bossDoc.attack_counts || {})[userId] || 0;
    const spent = Math.min(
      cfg().summon?.maxBonusAttacksPerPlayer ?? 5,
      Math.max(0, usedNow - baseLimitFor(bossDoc, guildAttackLimitBonus)),
    );
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, [`charge_counts.${userId}`]: { $exists: false } },
      { $set: { [`charge_counts.${userId}`]: spent } },
    ).catch(() => {});
  }

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

// 討伐道具（炸藥包 / 燃燒彈 / 雷符）造成的固定傷害：不是揮刀，所以不吃出刀次數、體力、
// 冷卻與魔王減傷，也不累積怒氣；但算進個人傷害與排行（獎勵照傷害佔比分）。
// 單場使用次數存在 boss doc 的 item_uses.<userId>.<key>，條件式原子更新＝兩個請求同時進來只有一個會過。
async function applyItemDamage(client, { userId, guildId, username, itemKey, damage, perBossUses, playerEventKey, debuffKey }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_boss" };
  const now = Date.now();
  if (bossDoc.ends_at != null && now >= bossDoc.ends_at) return { ok: false, reason: "expired" };

  const usedField = `item_uses.${userId}.${itemKey}`;
  const used = ((bossDoc.item_uses || {})[userId] || {})[itemKey] || 0;
  if (perBossUses > 0 && used >= perBossUses) {
    return { ok: false, reason: "used_up", used, limit: perBossUses };
  }

  const dmg = Math.max(1, Math.round(damage));
  const eventDef = playerEventKey ? bossPlayerEvents.eventDef(playerEventKey) : null;
  const fxEntry = eventDef ? bossPlayerEvents.fxEntry(eventDef, now) : null;
  // 道具掛的魔王 debuff 走既有的 active_skills：過期清理與狀態列都沿用魔王技能那一套。
  const debuffDef = debuffKey ? bossSkills.skillDef(debuffKey) : null;
  const debuffEntry = debuffDef
    ? {
      key: debuffDef.key,
      started_at: now,
      expires_at: now + (debuffDef.durationSec ?? 60) * 1000,
      hits_at_cast: bossDoc.hits_taken || 0,
    }
    : null;

  const inc = { current_hp: -dmg, [`damage_by_user.${userId}`]: dmg, [usedField]: 1 };
  if (bossBars.enabledFor(bossDoc)) inc[`bar_damage.${bossBars.barIndexForHit(bossDoc)}.${userId}`] = dmg;
  const update = {
    $inc: inc,
    $set: { last_hit_at: now, updatedAt: new Date() },
  };
  if (fxEntry || debuffEntry) {
    update.$push = {};
    if (fxEntry) update.$push[`player_fx.${userId}`] = fxEntry;
    if (debuffEntry) update.$push.active_skills = debuffEntry;
  }

  const res = await client.bossEventsCollection.findOneAndUpdate(
    {
      boss_id: bossDoc.boss_id,
      status: "active",
      ...(perBossUses > 0
        ? { $or: [{ [usedField]: { $lt: perBossUses } }, { [usedField]: { $exists: false } }] }
        : {}),
    },
    update,
    { returnDocument: "after" },
  );
  const afterDoc = res?.value || res;
  if (!afterDoc) return { ok: false, reason: "used_up", used, limit: perBossUses };

  let firstStrike = false;
  if (!afterDoc.first_striker) {
    const claim = await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, first_striker: null },
      { $set: { first_striker: userId } },
    );
    firstStrike = claim.modifiedCount === 1;
  }

  const rawHp = afterDoc.current_hp ?? 0;
  const newHp = Math.max(0, rawHp);
  const newPhase = phaseOf(newHp, bossDoc.max_hp, bossDoc.bars_total);
  const phaseChanged = newPhase !== bossDoc.phase;

  let killed = false;
  if (rawHp <= 0) {
    const claim = await client.bossEventsCollection.findOneAndUpdate(
      { boss_id: bossDoc.boss_id, status: "active" },
      { $set: { status: "defeated", killer_user_id: userId, killed_at: now, current_hp: 0, phase: newPhase } },
      { returnDocument: "after" },
    );
    killed = !!(claim?.value || claim);
  } else if (phaseChanged) {
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, status: "active" },
      { $set: { phase: newPhase } },
    );
  }

  const breaks = await bossBars.processBreaks(client, afterDoc, { breakerUserId: userId, now });

  await client.bossDamageLogsCollection.insertOne({
    boss_id: bossDoc.boss_id,
    guild_id: guildId,
    user_id: userId,
    username,
    damage: dmg,
    is_counter: false,
    via_item: itemKey,
    phase: newPhase,
    ts: now,
  });

  bus.emit("boss.attacked", { userId, guildId, bossId: bossDoc.boss_id, damage: dmg, isCounter: false, phaseAfter: newPhase });
  if (killed) bus.emit("boss.killed", { userId, guildId, bossId: bossDoc.boss_id });

  return {
    ok: true,
    damage: dmg,
    killed,
    firstStrike,
    phaseBefore: bossDoc.phase,
    phaseAfter: newPhase,
    phaseChanged,
    usedAfter: used + 1,
    limit: perBossUses,
    myDamage: (afterDoc.damage_by_user || {})[userId] || 0,
    playerFx: eventDef,
    debuff: debuffEntry ? { def: debuffDef, expiresAt: debuffEntry.expires_at } : null,
    playerFxLabels: bossPlayerEvents.statusLines(afterDoc, userId, now),
    barEvents: breaks.events,
    boss: {
      ...bossDoc,
      current_hp: newHp,
      phase: newPhase,
      bars_broken: breaks.boss?.bars_broken ?? afterDoc.bars_broken,
      bar_damage: afterDoc.bar_damage,
      active_skills: breaks.boss?.active_skills || afterDoc.active_skills,
    },
  };
}

// 管理員手動改血量：開場算太硬想收尾、或現場調節節奏時用。
// 扣血走 $inc（與玩家出刀同一種原子更新，不會蓋掉同時間打進來的傷害），
// 指定剩餘血量才用 $set。砍到 0 一樣要原子搶下 defeated，但沒有擊殺者＝不發擊殺獎。
async function adminAdjustHp(client, { guildId, cut = null, cutPct = null, setHp = null, adminId }) {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };

  const bossDoc = await getActiveBoss(client, guildId);
  if (!bossDoc) return { ok: false, reason: "no_active" };

  const now = Date.now();
  const before = bossDoc.current_hp ?? 0;
  const maxHp = bossDoc.max_hp ?? 0;
  const cutAmount = cutPct != null ? Math.round(maxHp * cutPct / 100) : (cut != null ? Math.round(cut) : null);
  const targetHp = setHp != null ? Math.max(0, Math.min(maxHp, Math.round(setHp))) : null;

  const update = {
    $set: { updatedAt: new Date() },
    $push: { admin_hp_edits: { by: adminId, cut: cutAmount, set_hp: targetHp, before, at: now } },
  };
  if (targetHp != null) update.$set.current_hp = targetHp;
  else update.$inc = { current_hp: -cutAmount };

  const res = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active" },
    update,
    { returnDocument: "after" },
  );
  const afterDoc = res?.value || res;
  if (!afterDoc) return { ok: false, reason: "expired" };

  const rawHp = afterDoc.current_hp ?? 0;
  const newHp = Math.max(0, Math.min(maxHp, rawHp));
  const newPhase = phaseOf(newHp, maxHp, bossDoc.bars_total);
  const phaseChanged = newPhase !== bossDoc.phase;

  let killed = false;
  if (rawHp <= 0) {
    const claim = await client.bossEventsCollection.findOneAndUpdate(
      { boss_id: bossDoc.boss_id, status: "active" },
      {
        $set: {
          status: "defeated",
          killed_at: now,
          current_hp: 0,
          phase: newPhase,
          killed_by_admin: adminId,
        },
      },
      { returnDocument: "after" },
    );
    killed = !!(claim?.value || claim);
  } else if (phaseChanged) {
    await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, status: "active" },
      { $set: { phase: newPhase } },
    );
  }

  // 管理員砍血一樣算打爆血條（照發該條血的獎勵池），只是沒有破條手。
  const breaks = await bossBars.processBreaks(client, afterDoc, { now });

  return {
    ok: true,
    before,
    after: newHp,
    delta: before - newHp,
    maxHp,
    killed,
    phaseBefore: bossDoc.phase,
    phaseAfter: newPhase,
    phaseChanged,
    barEvents: breaks.events,
    boss: { ...(breaks.boss || afterDoc), current_hp: newHp, phase: newPhase },
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
  applyItemDamage,
  adminAdjustHp,
  settleBoss,
  getActiveBoss,
  getBossInfo,
  findExpiredActiveBosses,
  findFreshlyDefeatedBosses,
  countOnlineMembers,
  expectedParticipants,
  computeScaledHp,
  computeAdaptiveHp,
  nextHpRatio,
  phaseOf,
  phaseDef,
  participationTier,
  rageState,
  effectiveCounterRate,
  baseAttackLimitFor,
  baseLimitFor,
};
