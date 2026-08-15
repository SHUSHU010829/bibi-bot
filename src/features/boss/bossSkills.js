// 魔王技能：戰鬥中每隔幾分鐘施放一個技能，臨時改寫當下的戰鬥規則
// （岩甲減傷、亂舞高反擊、詛咒禁會心、吸食回血、核心外露全場 ×2）。
//
// 存來源不存結果：boss doc 只存 active_skills（{ key, started_at, expires_at, hits_at_cast }）
// 與 next_skill_at，減傷 / 反擊 / 禁會心一律由 combinedEffects() 在攻擊當下即時換算。
//
// 本模組不碰 Discord：bossEngine 會 require 它，若這裡再 require bossBoard / bossAnnouncer
// 會形成循環 require。tick / castSkill 只回傳 events，公告由呼叫端（bossScheduler、指令層）發。
const { boss } = require("../../config");

function scfg() {
  return boss?.skills || {};
}

function skillList() {
  const list = scfg().list;
  return Array.isArray(list) ? list : [];
}

function skillDef(key) {
  return skillList().find((s) => s.key === key) || null;
}

function pickSkill() {
  const list = skillList();
  const total = list.reduce((s, d) => s + (d.weight || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const d of list) {
    r -= d.weight || 0;
    if (r <= 0) return d;
  }
  return list[list.length - 1];
}

// 場上仍生效的技能（過期的不算）。def 一併帶出來，呼叫端不用再查一次 config。
function activeSkills(bossDoc, now = Date.now()) {
  const entries = Array.isArray(bossDoc?.active_skills) ? bossDoc.active_skills : [];
  return entries
    .filter((e) => e.expires_at > now)
    .map((e) => ({ ...e, def: skillDef(e.key) }))
    .filter((e) => e.def);
}

// 多個技能同時在場時：減傷相乘、反擊相加、禁會心取聯集。
function combinedEffects(bossDoc, now = Date.now()) {
  const entries = activeSkills(bossDoc, now);
  let damageTakenMult = 1;
  let counterBonus = 0;
  let disableCrit = false;
  for (const e of entries) {
    if (e.def.damageTakenMult != null) damageTakenMult *= e.def.damageTakenMult;
    counterBonus += e.def.counterBonus || 0;
    if (e.def.disableCrit) disableCrit = true;
  }
  return { entries, damageTakenMult, counterBonus, disableCrit };
}

// 戰況面板 / 看板 / 攻擊結果共用的狀態行（技能 + 決戰階段）。
function statusLines(bossDoc, now = Date.now()) {
  const lines = activeSkills(bossDoc, now)
    .filter((e) => e.def.statusLabel)
    .map((e) => `${e.def.statusLabel} · <t:${Math.floor(e.expires_at / 1000)}:R> 結束`);
  const stage = finalStandStage(bossDoc, now);
  if (stage?.label) lines.push(stage.label);
  return lines;
}

// 決戰階段：限時場剩下越少時間，全場傷害倍率越高。
// 這既是收尾的戲劇性，也是難度校準的保險——就算血量估高了，最後 20 分鐘的輸出效率會補回來。
// 招喚場（ends_at = null）沒有時限，自然不吃這個。
function finalStandStage(bossDoc, now = Date.now()) {
  const cfg = boss?.finalStand || {};
  if (!cfg.enabled || bossDoc?.ends_at == null) return null;
  const remainMin = (bossDoc.ends_at - now) / 60000;
  const stages = Array.isArray(cfg.stages) ? cfg.stages : [];
  let best = null;
  for (const s of stages) {
    if (remainMin > s.remainingMinutes) continue;
    if (!best || s.remainingMinutes < best.remainingMinutes) best = s;
  }
  return best;
}

function finalStandMult(bossDoc, now = Date.now()) {
  return finalStandStage(bossDoc, now)?.damageMult ?? 1;
}

function fmt(tpl, vars) {
  if (!tpl) return null;
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

function castEvent(bossDoc, def, extra = {}) {
  const vars = {
    name: bossDoc.name,
    min: Math.round((def.durationSec || 0) / 60),
    sec: def.durationSec || 0,
    breakHits: def.breakHits || 0,
    heal: (extra.heal || 0).toLocaleString(),
  };
  return {
    type: "cast",
    key: def.key,
    text: fmt(def.castMessage, vars),
    hint: fmt(def.castHint, vars),
  };
}

function nextCastAt(now = Date.now()) {
  const interval = (scfg().intervalMinutes ?? 6) * 60000;
  const jitter = (scfg().intervalJitterMinutes ?? 0) * 60000;
  return now + interval + Math.round((Math.random() * 2 - 1) * jitter);
}

// 出場時排第一次施放。spawnBoss 直接把回傳值寫進 doc。
function initialState(now = Date.now()) {
  if (!scfg().enabled) return { active_skills: [], next_skill_at: null };
  return {
    active_skills: [],
    next_skill_at: now + (scfg().firstCastAfterMin ?? 4) * 60000,
  };
}

// 回血一律走 aggregation pipeline 的 $min，讓「加血」與「不超過上限」在同一個原子更新裡完成。
async function healBoss(client, bossId, amount) {
  if (amount <= 0) return null;
  const res = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossId, status: "active" },
    [
      {
        $set: {
          current_hp: { $min: ["$max_hp", { $add: ["$current_hp", amount] }] },
          updatedAt: "$$NOW",
        },
      },
    ],
    { returnDocument: "after" },
  );
  return res?.value || res || null;
}

async function castSkill(client, bossDoc, now = Date.now()) {
  const def = pickSkill();
  if (!def) return null;

  // 原子搶施放權：只有 next_skill_at 還是舊值的那一次 tick 會真的施放。
  const claim = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active", next_skill_at: bossDoc.next_skill_at },
    { $set: { next_skill_at: nextCastAt(now) } },
  );
  if (!(claim?.value || claim)) return null;

  if (def.healPct > 0) {
    const before = bossDoc.current_hp ?? 0;
    const amount = Math.round((bossDoc.max_hp || 0) * (def.healPct / 100));
    const after = await healBoss(client, bossDoc.boss_id, amount);
    const healed = after ? Math.max(0, (after.current_hp ?? before) - before) : 0;
    if (healed <= 0) return null;
    return { events: [castEvent(bossDoc, def, { heal: healed })], boss: after };
  }

  const entry = {
    key: def.key,
    started_at: now,
    expires_at: now + (def.durationSec ?? 60) * 1000,
    hits_at_cast: bossDoc.hits_taken || 0,
  };
  const res = await client.bossEventsCollection.findOneAndUpdate(
    { boss_id: bossDoc.boss_id, status: "active" },
    { $push: { active_skills: entry }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  return { events: [castEvent(bossDoc, def)], boss: res?.value || res };
}

// 過期技能的收尾公告。$pull 有改到才發，避免兩個 tick 各報一次。
async function expireSkills(client, bossDoc, now = Date.now()) {
  const entries = Array.isArray(bossDoc.active_skills) ? bossDoc.active_skills : [];
  const events = [];
  for (const e of entries) {
    if (e.expires_at > now) continue;
    const res = await client.bossEventsCollection.updateOne(
      { boss_id: bossDoc.boss_id, "active_skills.started_at": e.started_at, "active_skills.key": e.key },
      { $pull: { active_skills: { key: e.key, started_at: e.started_at } } },
    );
    if (res.modifiedCount !== 1) continue;
    const def = skillDef(e.key);
    if (def?.expireMessage) {
      events.push({ type: "expire", key: e.key, text: fmt(def.expireMessage, { name: bossDoc.name }) });
    }
  }
  return events;
}

// 脫戰回血：太久沒人出手就一直回，逼玩家維持輸出而不是放著慢慢磨。
async function idleRegen(client, bossDoc, now = Date.now()) {
  const cfg = boss?.idleRegen || {};
  if (!cfg.enabled) return null;
  const idleMs = (cfg.idleMinutes ?? 3) * 60000;
  const last = bossDoc.last_hit_at || bossDoc.started_at || now;
  if (now - last < idleMs) return null;
  if ((bossDoc.current_hp ?? 0) >= (bossDoc.max_hp ?? 0)) return null;

  const before = bossDoc.current_hp ?? 0;
  const amount = Math.round((bossDoc.max_hp || 0) * ((cfg.healPctPerMinute ?? 1) / 100));
  const after = await healBoss(client, bossDoc.boss_id, amount);
  const healed = after ? Math.max(0, (after.current_hp ?? before) - before) : 0;
  if (healed <= 0) return null;
  return {
    events: [{
      type: "regen",
      text: fmt(cfg.message, { name: bossDoc.name, heal: healed.toLocaleString() }),
      hint: cfg.hint || null,
    }],
    boss: after,
  };
}

// 每分鐘由 bossScheduler 呼叫：收過期技能 → 脫戰回血 → 到點施放新技能。
// 回傳 { events, boss }，公告由呼叫端負責發。
// 進入新的決戰階段時報一次。用 doc 上的 final_stand_stage 當去重條件（原子換值才發公告）。
async function announceFinalStand(client, bossDoc, now) {
  const stage = finalStandStage(bossDoc, now);
  if (!stage || bossDoc.final_stand_stage === stage.remainingMinutes) return null;
  const res = await client.bossEventsCollection.updateOne(
    { boss_id: bossDoc.boss_id, status: "active", final_stand_stage: { $ne: stage.remainingMinutes } },
    { $set: { final_stand_stage: stage.remainingMinutes } },
  );
  if (res.modifiedCount !== 1) return null;
  return { type: "final_stand", text: stage.announcement };
}

async function tick(client, bossDoc, now = Date.now()) {
  const events = [];
  let current = bossDoc;

  const fs = await announceFinalStand(client, current, now);
  if (fs) events.push(fs);

  events.push(...(await expireSkills(client, current, now)));

  const regen = await idleRegen(client, current, now);
  if (regen) {
    events.push(...regen.events);
    current = regen.boss || current;
  }

  if (scfg().enabled && current.next_skill_at && now >= current.next_skill_at) {
    const cast = await castSkill(client, { ...current, next_skill_at: bossDoc.next_skill_at }, now);
    if (cast) {
      events.push(...cast.events);
      current = cast.boss || current;
    }
  }

  return { events, boss: current };
}

// 岩甲類技能的「合力打碎」：施放後全場再累積 breakHits 次出手就提前解除。
// 用 boss doc 既有的 hits_taken 當計數器，不另外開欄位（每刀都會 $inc，天生原子）。
function pendingBreak(bossDoc, now = Date.now()) {
  return activeSkills(bossDoc, now).find(
    (e) => e.def.breakHits > 0 && (bossDoc.hits_taken || 0) - (e.hits_at_cast || 0) >= e.def.breakHits,
  ) || null;
}

// 打碎技能。只有原子 $pull 真的改到的那一刀算「打碎的人」，回傳公告文字。
async function breakSkill(client, bossDoc, entry) {
  const res = await client.bossEventsCollection.updateOne(
    { boss_id: bossDoc.boss_id, "active_skills.started_at": entry.started_at, "active_skills.key": entry.key },
    { $pull: { active_skills: { key: entry.key, started_at: entry.started_at } } },
  );
  if (res.modifiedCount !== 1) return null;
  return {
    type: "break",
    key: entry.key,
    text: fmt(entry.def.breakMessage, { name: bossDoc.name }),
  };
}

module.exports = {
  scfg,
  skillDef,
  activeSkills,
  combinedEffects,
  finalStandStage,
  finalStandMult,
  statusLines,
  initialState,
  tick,
  pendingBreak,
  breakSkill,
};
