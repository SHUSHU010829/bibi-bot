// 玩家攻擊事件：每一刀有機率觸發的個人隨機事件（戰吼增傷、必定會心、免疫反擊、
// 天降隕石、撿錢袋、退還出刀次數、踩香蕉皮…），讓同樣的「再砍一刀」有變化。
//
// 存來源不存結果：持續型效果只在 BossEvents doc 的 player_fx.<userId> 存
// { key, started_at, expires_at }，倍率一律由 effectsOf() 在出手當下換算；
// 戰鬥結束整份 doc 失效，不寫進玩家 profile，也不需要排程清理。
//
// 本模組不碰 Discord：只吃 boss doc + config，回傳事件定義與文字，
// 實際扣血 / 給錢 / 退刀由 bossEngine 執行，公告由指令層發。
const { boss } = require("../../config");

function pcfg() {
  return boss?.playerEvents || {};
}

function eventList() {
  const list = pcfg().list;
  return Array.isArray(list) ? list : [];
}

function eventDef(key) {
  return eventList().find((e) => e.key === key) || null;
}

// 這名玩家身上仍生效的事件效果（過期的不算）。
function effectsOf(bossDoc, userId, now = Date.now()) {
  const raw = (bossDoc?.player_fx || {})[userId];
  const entries = (Array.isArray(raw) ? raw : [])
    .filter((e) => e.expires_at > now)
    .map((e) => ({ ...e, def: eventDef(e.key) }))
    .filter((e) => e.def);
  let damageMult = 1;
  let forceCrit = false;
  let counterImmune = false;
  for (const e of entries) {
    if (e.def.damageMult != null) damageMult *= e.def.damageMult;
    if (e.def.forceCrit) forceCrit = true;
    if (e.def.counterImmune) counterImmune = true;
  }
  return { entries, damageMult, forceCrit, counterImmune };
}

// 攻擊結果 / 戰況面板用的個人狀態行。
function statusLines(bossDoc, userId, now = Date.now()) {
  return effectsOf(bossDoc, userId, now)
    .entries
    .filter((e) => e.def.statusLabel)
    .map((e) => `${e.def.statusLabel} · <t:${Math.floor(e.expires_at / 1000)}:R> 結束`);
}

function pickEvent() {
  const list = eventList();
  const total = list.reduce((s, d) => s + (d.weight || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const d of list) {
    r -= d.weight || 0;
    if (r <= 0) return d;
  }
  return list[list.length - 1];
}

function cooldownMs() {
  return (pcfg().cooldownSec ?? 0) * 1000;
}

// 命中當下擲一次：機率沒中 / 個人冷卻還在 → null。
// 同一個玩家連續觸發會洗版，所以觸發後進個人冷卻（存在 doc 的 event_cd.<userId>）。
function roll(bossDoc, userId, now = Date.now()) {
  if (!pcfg().enabled) return null;
  if (now < ((bossDoc?.event_cd || {})[userId] || 0)) return null;
  if (Math.random() >= (pcfg().chancePerHit ?? 0)) return null;
  return pickEvent();
}

// 有持續時間的事件才需要寫進 doc；一次性的（隕石 / 錢袋 / 退刀）當場結算完就沒了。
function fxEntry(def, now = Date.now()) {
  if (!def?.durationSec) return null;
  return { key: def.key, started_at: now, expires_at: now + def.durationSec * 1000 };
}

function fmt(tpl, vars) {
  if (!tpl) return null;
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }
  return out;
}

function describe(def, { displayName, damage, stamina, coins }) {
  return fmt(def.message, {
    user: displayName,
    min: Math.round((def.durationSec || 0) / 60),
    sec: def.durationSec || 0,
    damage: (damage || 0).toLocaleString(),
    stamina: stamina || 0,
    coins: (coins || 0).toLocaleString(),
  });
}

module.exports = {
  pcfg,
  eventDef,
  effectsOf,
  statusLines,
  roll,
  fxEntry,
  cooldownMs,
  describe,
};
