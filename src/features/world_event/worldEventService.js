require("colors");
const crypto = require("crypto");
const { worldEvents } = require("../../config");
const worldEventBuffs = require("./worldEventBuffs");

const isEnabled = () => worldEvents?.enabled !== false;
const cfg = () => worldEvents || {};
const eventDef = (id) => (cfg().events || []).find((e) => e.id === id) || null;
const allEventIds = () => (cfg().events || []).map((e) => e.id);

const collectWindowMs = () => (cfg().donation?.collectWindowHours || 24) * 3600 * 1000;
const defaultBuffMs = () => (cfg().donation?.buffDurationHours || 24) * 3600 * 1000;
const cooldownMs = () => (cfg().donation?.cooldownHours || 168) * 3600 * 1000;
const globalCooldownMs = () => (cfg().donation?.globalCooldownHours || 72) * 3600 * 1000;
const concurrent = () => cfg().concurrent || 1;

const newEventDbId = () => `we_${crypto.randomBytes(4).toString("hex")}`;

// 取「目前活躍」事件（state collecting / buffing）
async function getActiveEvents(client) {
  if (!client?.worldEventsCollection) return [];
  return await client.worldEventsCollection
    .find({ state: { $in: ["collecting", "buffing"] } })
    .sort({ started_at: -1 })
    .toArray()
    .catch(() => []);
}

async function getCollectingEvent(client) {
  if (!client?.worldEventsCollection) return null;
  return await client.worldEventsCollection
    .findOne({ state: "collecting" })
    .catch(() => null);
}

// 同類事件冷卻：上一筆 ended 的 ended_at + cooldown
async function isOnCooldown(client, eventId) {
  if (!client?.worldEventsCollection) return false;
  const last = await client.worldEventsCollection
    .find({ event_id: eventId, state: "ended" })
    .sort({ ended_at: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  if (!last[0]) return false;
  const since = new Date(last[0].ended_at).getTime();
  return Date.now() - since < cooldownMs();
}

// 全域冷卻：任何事件觸發後 globalCooldown 內，所有事件都不能再開
async function isOnGlobalCooldown(client) {
  if (!client?.worldEventsCollection) return false;
  const last = await client.worldEventsCollection
    .find({})
    .sort({ started_at: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  if (!last[0]?.started_at) return false;
  const since = new Date(last[0].started_at).getTime();
  return Date.now() - since < globalCooldownMs();
}

// 嘗試開啟事件：(1) 並發上限 (2) 冷卻中 (3) trigger 條件
// 回傳 { opened: bool, event? } — opened=false 時不報錯，呼叫端決定要不要通知。
async function tryOpenEvent(client, eventId) {
  if (!isEnabled()) return { opened: false, reason: "disabled" };
  if (!client?.worldEventsCollection) return { opened: false, reason: "disabled" };

  const def = eventDef(eventId);
  if (!def) return { opened: false, reason: "unknown_event" };

  const active = await getActiveEvents(client);
  const collecting = active.filter((e) => e.state === "collecting").length;
  if (collecting >= concurrent()) return { opened: false, reason: "concurrent_full" };

  if (await isOnGlobalCooldown(client)) return { opened: false, reason: "global_cooldown" };
  if (await isOnCooldown(client, eventId)) return { opened: false, reason: "cooldown" };

  const now = new Date();
  const endsAt = new Date(now.getTime() + collectWindowMs());

  const doc = {
    event_db_id: newEventDbId(),
    event_id: eventId,
    state: "collecting",
    started_at: now,
    ends_at: endsAt,
    requirements_remaining: { ...(def.requirements || {}) },
    requirements_total: { ...(def.requirements || {}) },
    total_contributions: {},
    rewards: def.rewards || {},
    label: def.label,
    emoji: def.emoji,
    description: def.description,
    color: def.color,
  };

  try {
    await client.worldEventsCollection.insertOne(doc);
  } catch (e) {
    return { opened: false, reason: "insert_failed", err: e.message };
  }

  return { opened: true, event: doc };
}

// 觸發掛勾：在挖礦掉落、釣魚成功、收成、地下城通關後被呼叫。
// kind: "mining_drop" | "fish_catch" | "farm_harvest" | "dungeon_clear"
// params 視 kind 不同：{ ore } / { fish } / { crop }
async function rollTrigger(client, kind, params = {}) {
  if (!isEnabled()) return;
  if (!client?.worldEventsCollection) return;

  for (const def of cfg().events || []) {
    const t = def.trigger;
    if (!t || t.kind !== kind) continue;
    if (t.ore && t.ore !== params.ore) continue;
    if (t.fish && t.fish !== params.fish) continue;
    if (t.crop && t.crop !== params.crop) continue;
    const chance = (t.chancePct || 0) / 100;
    if (chance <= 0) continue;
    if (Math.random() >= chance) continue;
    // 命中：嘗試開啟。並發 / 冷卻擋掉就靜默跳過。
    const r = await tryOpenEvent(client, def.id).catch(() => ({ opened: false }));
    if (r?.opened) return r.event;
  }
  return null;
}

// 捐獻：自動扣 (個人 mining profile / 公會倉庫) 並更新進度。
// 規則：
//   - rare ores（iron / gold / coal）優先扣個人背包，不足則扣公會倉庫
//   - 魚、菜先扣個人對應袋子，不足扣公會倉庫
//   - 玩家可指定 from = "personal" | "guild" 強制來源
async function donate(client, { userId, guildId, eventDbId, itemId, qty, from }) {
  if (!isEnabled()) return { ok: false, reason: "disabled" };
  if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: "invalid_qty" };

  const event = await client.worldEventsCollection
    .findOne({ event_db_id: eventDbId })
    .catch(() => null);
  if (!event) return { ok: false, reason: "event_not_found" };
  if (event.state !== "collecting") return { ok: false, reason: "event_not_collecting" };
  if (event.ends_at && new Date(event.ends_at).getTime() < Date.now()) {
    return { ok: false, reason: "event_expired" };
  }

  const remaining = (event.requirements_remaining || {})[itemId] || 0;
  if (remaining <= 0) return { ok: false, reason: "no_more_needed", item_id: itemId };
  const actualQty = Math.min(qty, remaining);

  // 決定來源：先看個人背包再公會倉庫
  const { guildWarehouse } = require("../../config");
  const itemMeta = guildWarehouse?.items?.[itemId];
  const bagField =
    itemMeta?.kind === "fish_bag"
      ? "fish_bag"
      : itemMeta?.kind === "veggie_bag"
      ? "veggie_bag"
      : "backpack";

  const profile = await client.miningProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  const havePersonal = profile?.[bagField]?.[itemId] || 0;

  let takeFromPersonal = 0;
  let takeFromGuild = 0;

  if (from === "guild") {
    takeFromGuild = actualQty;
  } else if (from === "personal") {
    takeFromPersonal = actualQty;
  } else {
    takeFromPersonal = Math.min(havePersonal, actualQty);
    takeFromGuild = actualQty - takeFromPersonal;
  }

  // 個人來源：扣 mining profile
  if (takeFromPersonal > 0) {
    const dec = await client.miningProfilesCollection.updateOne(
      {
        userId,
        guildId,
        [`${bagField}.${itemId}`]: { $gte: takeFromPersonal },
      },
      {
        $inc: { [`${bagField}.${itemId}`]: -takeFromPersonal },
        $set: { updatedAt: new Date() },
      }
    );
    if (dec.modifiedCount === 0)
      return { ok: false, reason: "insufficient_personal", have: havePersonal, need: takeFromPersonal };
  }

  // 公會來源：扣公會倉庫
  let guildClubId = null;
  if (takeFromGuild > 0) {
    const m = await client.guildClubMembersCollection
      .findOne({ userId, guildId })
      .catch(() => null);
    if (!m) {
      // 回滾個人
      if (takeFromPersonal > 0) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          {
            $inc: { [`${bagField}.${itemId}`]: takeFromPersonal },
            $set: { updatedAt: new Date() },
          }
        ).catch(() => {});
      }
      return { ok: false, reason: "guild_source_needs_membership" };
    }
    guildClubId = m.guild_club_id;
    const dec = await client.guildClubWarehouseCollection.findOneAndUpdate(
      {
        guild_club_id: guildClubId,
        item_id: itemId,
        available_qty: { $gte: takeFromGuild },
      },
      {
        $inc: { qty: -takeFromGuild, available_qty: -takeFromGuild },
        $set: { updated_at: new Date() },
      },
      { returnDocument: "after" }
    );
    if (!(dec?.value || dec)) {
      // 回滾個人
      if (takeFromPersonal > 0) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId },
          {
            $inc: { [`${bagField}.${itemId}`]: takeFromPersonal },
            $set: { updatedAt: new Date() },
          }
        ).catch(() => {});
      }
      return { ok: false, reason: "insufficient_guild_warehouse", item_id: itemId, need: takeFromGuild };
    }
  }

  // 更新事件進度
  const upd = await client.worldEventsCollection.findOneAndUpdate(
    {
      event_db_id: eventDbId,
      state: "collecting",
      [`requirements_remaining.${itemId}`]: { $gte: actualQty },
    },
    {
      $inc: {
        [`requirements_remaining.${itemId}`]: -actualQty,
        [`total_contributions.${itemId}`]: actualQty,
      },
      $set: { updated_at: new Date() },
    },
    { returnDocument: "after" }
  );
  const updDoc = upd?.value || upd;
  if (!updDoc) {
    // 回滾兩邊
    if (takeFromPersonal > 0) {
      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        {
          $inc: { [`${bagField}.${itemId}`]: takeFromPersonal },
          $set: { updatedAt: new Date() },
        }
      ).catch(() => {});
    }
    if (takeFromGuild > 0 && guildClubId) {
      await client.guildClubWarehouseCollection.updateOne(
        { guild_club_id: guildClubId, item_id: itemId },
        {
          $inc: { qty: takeFromGuild, available_qty: takeFromGuild },
          $set: { updated_at: new Date() },
        }
      ).catch(() => {});
    }
    return { ok: false, reason: "event_progress_race" };
  }

  // 寫貢獻明細
  await client.worldEventContributionsCollection.insertOne({
    event_db_id: eventDbId,
    event_id: updDoc.event_id,
    user_id: userId,
    guild_id: guildId,
    item_id: itemId,
    qty: actualQty,
    from_personal: takeFromPersonal,
    from_guild: takeFromGuild,
    created_at: new Date(),
  }).catch(() => {});

  // 檢查達標
  const remainingAll = Object.values(updDoc.requirements_remaining || {});
  const completed = remainingAll.every((v) => (v || 0) <= 0);
  let buffStarted = false;
  let buffEndsAt = null;
  if (completed && updDoc.state === "collecting") {
    const buffMs = (eventDef(updDoc.event_id)?.buffDurationHoursOverride || 0) * 3600 * 1000
      || defaultBuffMs();
    const endsAt = new Date(Date.now() + buffMs);
    const transition = await client.worldEventsCollection.findOneAndUpdate(
      { event_db_id: eventDbId, state: "collecting" },
      { $set: { state: "buffing", buff_started_at: new Date(), ends_at: endsAt, updated_at: new Date() } },
      { returnDocument: "after" }
    );
    if (transition?.value || transition) {
      buffStarted = true;
      buffEndsAt = endsAt;
      await worldEventBuffs.refreshCache(client).catch(() => {});
    }
  }

  return {
    ok: true,
    event: updDoc,
    deposited: actualQty,
    fromPersonal: takeFromPersonal,
    fromGuild: takeFromGuild,
    buffStarted,
    buffEndsAt,
    completed,
  };
}

// 用於 scheduler：處理過期。collecting 過 ends_at → ended（失敗）。
//                            buffing 過 ends_at → ended（buff 結束）。
async function settleExpired(client) {
  if (!client?.worldEventsCollection) return { changed: 0 };
  const now = new Date();
  const list = await client.worldEventsCollection
    .find({ state: { $in: ["collecting", "buffing"] }, ends_at: { $lte: now } })
    .toArray()
    .catch(() => []);

  let changed = 0;
  const transitions = [];
  for (const e of list) {
    const wasBuffing = e.state === "buffing";
    const upd = await client.worldEventsCollection.findOneAndUpdate(
      { event_db_id: e.event_db_id, state: e.state },
      { $set: { state: "ended", ended_at: now, updated_at: now } },
      { returnDocument: "after" }
    );
    if (upd?.value || upd) {
      changed++;
      transitions.push({ event: e, from: wasBuffing ? "buffing" : "collecting" });
    }
  }
  if (changed > 0) await worldEventBuffs.refreshCache(client).catch(() => {});
  return { changed, transitions };
}

module.exports = {
  isEnabled,
  eventDef,
  allEventIds,
  collectWindowMs,
  defaultBuffMs,
  cooldownMs,
  globalCooldownMs,
  getActiveEvents,
  getCollectingEvent,
  isOnCooldown,
  isOnGlobalCooldown,
  tryOpenEvent,
  rollTrigger,
  donate,
  settleExpired,
};
