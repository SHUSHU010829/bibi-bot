require("colors");

const { DateTime } = require("luxon");
const config = require("../../config");

// Phase S5 — 限時活動 / 節日系統框架核心
//
// 設計重點：
// - 完全設定檔驅動：活動定義放 `src/config/events.json` 的 eventSystem.events，
//   開新活動只需加一筆，不必改程式。
// - 純函式為主（讀設定 + Date.now()），可被挖礦掉落 / buffResolver / 任務系統同步呼叫。
// - 活動效果在「生效視窗內」才注入：限定礦石、挖礦幸運 / 數量加成、限定任務。
// - 已結束的活動仍保留設定，使玩家背包裡的限定礦石之後仍查得到 def、賣得掉。
// - 管理員可用 force-start / force-end 進程內覆寫生效狀態（測試用，不持久化）。

const DEFAULT_TZ = "Asia/Taipei";

// 進程內強制覆寫：id -> 'start' | 'end'。重啟即失效，僅供測試 / 臨時調整。
const forceOverrides = new Map();

function cfg() {
  return config.eventSystem || {};
}

function isSystemEnabled() {
  return cfg().enabled !== false;
}

function timezone() {
  return cfg().timezone || DEFAULT_TZ;
}

function allEvents() {
  return Array.isArray(cfg().events) ? cfg().events : [];
}

// 解析活動時間字串為 epoch ms。無時區資訊者以設定時區解讀；含 offset 則尊重之。
function parseTime(str) {
  if (!str) return null;
  const dt = DateTime.fromISO(str, { zone: timezone() });
  return dt.isValid ? dt.toMillis() : null;
}

function eventWindow(event) {
  return { startMs: parseTime(event?.startAt), endMs: parseTime(event?.endAt) };
}

function getForce(id) {
  return forceOverrides.get(id) || null;
}

// 活動是否生效中（含 force 覆寫；停用者永不生效）
function isActive(event, nowMs = Date.now()) {
  if (!event || event.enabled === false) return false;
  const ov = forceOverrides.get(event.id);
  if (ov === "start") return true;
  if (ov === "end") return false;
  const { startMs, endMs } = eventWindow(event);
  if (startMs == null || endMs == null) return false;
  return nowMs >= startMs && nowMs < endMs;
}

function getActiveEvents(nowMs = Date.now()) {
  if (!isSystemEnabled()) return [];
  return allEvents().filter((e) => isActive(e, nowMs));
}

// 即將開始的活動（startMs 在 [now, now+withinMs)），依開始時間排序
function getUpcomingEvents(nowMs = Date.now(), withinMs = null) {
  if (!isSystemEnabled()) return [];
  const within =
    withinMs != null
      ? withinMs
      : (cfg().upcomingWithinHours || 48) * 60 * 60 * 1000;
  return allEvents()
    .filter((e) => {
      if (e.enabled === false) return false;
      if (getForce(e.id) === "start") return false;
      const { startMs } = eventWindow(e);
      return startMs != null && startMs > nowMs && startMs - nowMs <= within;
    })
    .sort((a, b) => eventWindow(a).startMs - eventWindow(b).startMs);
}

function getEventById(id) {
  return allEvents().find((e) => e.id === id) || null;
}

// ── 礦石注入 ────────────────────────────────────────────
function normalizeOre(o) {
  return {
    name: o.name || o.id,
    emoji: o.emoji || "✨",
    rarity: o.rarity || "限定",
    weight: Number(o.weight) || 0,
    luckFactor: Number(o.luckFactor) || 0,
    price: Number(o.price) || 0,
    minQty: o.minQty ?? 1,
    maxQty: o.maxQty ?? (o.minQty ?? 1),
    event: true,
  };
}

// 單一活動的限定礦石清單 [{ key, def }]（支援 effects.extraOre 物件或 extraOres 陣列）
function eventExtraOres(event) {
  const effects = event?.effects || {};
  const raw = [];
  if (effects.extraOre) raw.push(effects.extraOre);
  if (Array.isArray(effects.extraOres)) raw.push(...effects.extraOres);
  return raw
    .filter((o) => o && o.id)
    .map((o) => ({ key: o.id, def: normalizeOre(o) }));
}

// 掉落用的有效礦石表：基礎礦石 + 生效中活動的限定礦石
function getEffectiveOreDefs(nowMs = Date.now()) {
  const base = (config.mining && config.mining.ores) || {};
  const merged = { ...base };
  for (const e of getActiveEvents(nowMs)) {
    for (const { key, def } of eventExtraOres(e)) merged[key] = def;
  }
  return merged;
}

// 解析任一礦石 def（顯示 / 計價用）：基礎 → 生效活動 → 任一活動（含已結束，
// 讓玩家背包裡的限定礦石之後仍查得到名稱與賣價）。
function resolveOreDef(key, nowMs = Date.now()) {
  const base = (config.mining && config.mining.ores) || {};
  if (base[key]) return base[key];
  for (const e of getActiveEvents(nowMs)) {
    for (const { key: k, def } of eventExtraOres(e)) if (k === key) return def;
  }
  for (const e of allEvents()) {
    for (const { key: k, def } of eventExtraOres(e)) if (k === key) return def;
  }
  return null;
}

// ── 魚類注入（釣魚限時活動）────────────────────────────
// 與礦石同構，差別在釣魚掉落表是「分釣點」的：限定魚可指定出沒的釣點與掉落權重，
// 只在生效活動且該釣點才混進魚群。魚定義（名稱/賣價/rareFactor）則跨釣點共用。
function normalizeFish(f) {
  const locations =
    f.locations == null || f.locations === "all"
      ? "all"
      : Array.isArray(f.locations)
        ? f.locations
        : [f.locations];
  return {
    name: f.name || f.id,
    emoji: f.emoji || "🐟",
    rarity: f.rarity || "限定",
    price: Number(f.price) || 0,
    rareFactor: Number(f.rareFactor) || 0,
    weight: Number(f.weight) || 0,
    locations,
    event: true,
  };
}

// 單一活動的限定魚清單 [{ key, def }]（支援 effects.extraFish 物件或 extraFishes 陣列）
function eventExtraFish(event) {
  const effects = event?.effects || {};
  const raw = [];
  if (effects.extraFish) raw.push(effects.extraFish);
  if (Array.isArray(effects.extraFishes)) raw.push(...effects.extraFishes);
  return raw
    .filter((f) => f && f.id)
    .map((f) => ({ key: f.id, def: normalizeFish(f) }));
}

function fishAppearsAt(def, location) {
  return (
    def.locations === "all" ||
    (Array.isArray(def.locations) && def.locations.includes(location))
  );
}

// 掉落用的有效魚權重表：某釣點的基礎魚權重 + 生效中活動、且在該釣點出沒的限定魚權重。
function getEffectiveFishWeights(location, nowMs = Date.now()) {
  const base = { ...((config.fishing?.dropTable || {})[location] || {}) };
  for (const e of getActiveEvents(nowMs)) {
    for (const { key, def } of eventExtraFish(e)) {
      if (fishAppearsAt(def, location)) base[key] = def.weight;
    }
  }
  return base;
}

// 有效魚定義表（顯示 / 計價用）：基礎魚 + 生效中活動限定魚。
function getEffectiveFishDefs(nowMs = Date.now()) {
  const base = { ...(config.fishing?.fish || {}) };
  for (const e of getActiveEvents(nowMs)) {
    for (const { key, def } of eventExtraFish(e)) base[key] = def;
  }
  return base;
}

// 解析任一魚 def（顯示 / 計價）：基礎 → 生效活動 → 任一活動（含已結束，
// 讓玩家魚袋裡的限定魚之後仍查得到名稱與賣價）。比照 resolveOreDef。
function resolveFishDef(key, nowMs = Date.now()) {
  const base = config.fishing?.fish || {};
  if (base[key]) return base[key];
  for (const e of getActiveEvents(nowMs)) {
    for (const { key: k, def } of eventExtraFish(e)) if (k === key) return def;
  }
  for (const e of allEvents()) {
    for (const { key: k, def } of eventExtraFish(e)) if (k === key) return def;
  }
  return null;
}

function getFishingSuccessBonus(nowMs = Date.now()) {
  return getActiveEvents(nowMs).reduce(
    (s, e) => s + (Number(e.effects?.fishingSuccessBonus) || 0),
    0,
  );
}

function getFishingRareBonus(nowMs = Date.now()) {
  return getActiveEvents(nowMs).reduce(
    (s, e) => s + (Number(e.effects?.fishingRareBonus) || 0),
    0,
  );
}

// ── buff 注入 ──────────────────────────────────────────
function getMiningLuckBonus(nowMs = Date.now()) {
  return getActiveEvents(nowMs).reduce(
    (s, e) => s + (Number(e.effects?.miningLuckBonus) || 0),
    0,
  );
}

function getMiningQtyBonus(nowMs = Date.now()) {
  return getActiveEvents(nowMs).reduce(
    (s, e) => s + (Number(e.effects?.miningQtyBonus) || 0),
    0,
  );
}

// ── 任務注入 ──────────────────────────────────────────
// 生效中活動的限定任務，period 標成 `evt-<id>`，questService 以此 token 作週期鍵。
function getEventQuests(nowMs = Date.now()) {
  const out = [];
  for (const e of getActiveEvents(nowMs)) {
    for (const q of e.quests || []) {
      out.push({
        ...q,
        period: `evt-${e.id}`,
        eventId: e.id,
        eventName: e.name,
      });
    }
  }
  return out;
}

function getEventQuestById(id, nowMs = Date.now()) {
  return getEventQuests(nowMs).find((q) => q.id === id) || null;
}

// ── 限定魚兌換所 ───────────────────────────────────────
// 生效中活動的兌換項目（成本＝限定魚、獎勵＝金幣/CD券/通行證/稱號）。
// 每筆帶上所屬活動資訊，id 需全域唯一（兌換 handler 以 id 定位）。
function getEventExchanges(nowMs = Date.now()) {
  const out = [];
  for (const e of getActiveEvents(nowMs)) {
    for (const x of e.exchange || []) {
      if (x && x.id) out.push({ ...x, eventId: e.id, eventName: e.name });
    }
  }
  return out;
}

function getEventExchangeById(id, nowMs = Date.now()) {
  return getEventExchanges(nowMs).find((x) => x.id === id) || null;
}

// 取得某觸發類型（如 'mine_count'）對應的進度 hook，供指令層併入 applyQuestHooks。
// ctx 可帶 { ore }，活動任務可用 condition.ore 過濾特定礦石。
function getEventQuestHooksByType(type, ctx = {}, nowMs = Date.now()) {
  const hooks = [];
  for (const q of getEventQuests(nowMs)) {
    const cond = q.condition || {};
    if (cond.type !== type) continue;
    if (cond.ore && ctx.ore && cond.ore !== ctx.ore) continue;
    if (cond.fish && ctx.fish && cond.fish !== ctx.fish) continue;
    hooks.push({ questId: q.id });
  }
  return hooks;
}

// ── 管理員 force 覆寫 ──────────────────────────────────
function forceStart(id) {
  if (!getEventById(id)) return false;
  forceOverrides.set(id, "start");
  return true;
}

function forceEnd(id) {
  if (!getEventById(id)) return false;
  forceOverrides.set(id, "end");
  return true;
}

function clearForce(id) {
  return forceOverrides.delete(id);
}

// 活動狀態標籤（給管理 / 公告用）
function statusOf(event, nowMs = Date.now()) {
  if (event.enabled === false) return "disabled";
  const ov = getForce(event.id);
  if (ov === "start") return "active";
  if (ov === "end") return "ended";
  const { startMs, endMs } = eventWindow(event);
  if (startMs == null || endMs == null) return "invalid";
  if (nowMs < startMs) return "upcoming";
  if (nowMs >= endMs) return "ended";
  return "active";
}

module.exports = {
  cfg,
  isSystemEnabled,
  timezone,
  allEvents,
  parseTime,
  eventWindow,
  isActive,
  getActiveEvents,
  getUpcomingEvents,
  getEventById,
  eventExtraOres,
  getEffectiveOreDefs,
  resolveOreDef,
  eventExtraFish,
  getEffectiveFishWeights,
  getEffectiveFishDefs,
  resolveFishDef,
  getFishingSuccessBonus,
  getFishingRareBonus,
  getMiningLuckBonus,
  getMiningQtyBonus,
  getEventQuests,
  getEventQuestById,
  getEventQuestHooksByType,
  getEventExchanges,
  getEventExchangeById,
  forceStart,
  forceEnd,
  clearForce,
  getForce,
  statusOf,
};
