require("colors");
const crypto = require("crypto");
const { DateTime } = require("luxon");
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

const isMainline = (def) => def?.kind === "mainline";

// 逼幣在 requirements 裡的 item id。它不是倉庫物品，扣的是錢包。
const CURRENCY_ITEM = "coins";

// 今天（台北日界）某人對某事件已投入的量。沿用貢獻明細 aggregate，
// 不另存每日計數欄位——活動結束後明細還要拿來發稱號，本來就得保留。
async function donatedTodayBy(client, { eventDbId, userId, itemId }) {
  if (!client?.worldEventContributionsCollection) return 0;
  const startOfToday = DateTime.now().setZone("Asia/Taipei").startOf("day").toJSDate();
  const [agg] = await client.worldEventContributionsCollection
    .aggregate([
      {
        $match: {
          event_db_id: eventDbId,
          user_id: userId,
          item_id: itemId,
          created_at: { $gte: startOfToday },
        },
      },
      { $group: { _id: null, total: { $sum: "$qty" } } },
    ])
    .toArray()
    .catch(() => []);
  return agg?.total || 0;
}

// 逼幣捐獻：條件式原子扣款，餘額不足就整筆不動（捐獻按鈕可連點，不能讓餘額變負）。
// 欄位比照 grantCoins 的寫法（totalCoins / lifetimeSpent / coinsFrom_<source>）。
async function donateCoins(client, { userId, guildId, event, eventDbId, amount }) {
  if (!client?.userCoinsCollection) return { ok: false, reason: "disabled" };
  const SOURCE = "world_event_donate";

  const dec = await client.userCoinsCollection.updateOne(
    { userId, guildId, totalCoins: { $gte: amount } },
    {
      $inc: {
        totalCoins: -amount,
        lifetimeSpent: amount,
        [`coinsFrom_${SOURCE}`]: -amount,
      },
      $set: { updatedAt: new Date() },
    }
  );
  if (dec.modifiedCount === 0) {
    const doc = await client.userCoinsCollection.findOne({ userId, guildId }).catch(() => null);
    return { ok: false, reason: "insufficient_coins", have: doc?.totalCoins || 0, need: amount };
  }

  client.coinTransactionsCollection
    ?.insertOne({
      userId,
      guildId,
      amount: -amount,
      source: SOURCE,
      meta: { event_db_id: eventDbId, event_id: event.event_id },
      date: DateTime.now().setZone("Asia/Taipei").toISODate(),
      createdAt: new Date(),
    })
    .catch(() => {});

  return applyProgress(client, {
    eventDbId,
    itemId: CURRENCY_ITEM,
    actualQty: amount,
    userId,
    guildId,
    fromCoins: amount,
    rollback: async () => {
      await client.userCoinsCollection.updateOne(
        { userId, guildId },
        {
          $inc: {
            totalCoins: amount,
            lifetimeSpent: -amount,
            [`coinsFrom_${SOURCE}`]: amount,
          },
        }
      ).catch(() => {});
    },
  });
}

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

// 全域冷卻：任何事件觸發後 globalCooldown 內，所有事件都不能再開。
// 主線活動不計入——否則開一次主線就把後續一般事件鎖 72 小時。
async function isOnGlobalCooldown(client) {
  if (!client?.worldEventsCollection) return false;
  const last = await client.worldEventsCollection
    .find({ kind: { $ne: "mainline" } })
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
//
// 主線活動（kind: "mainline"）走另一條規則：它會跑好幾天甚至幾週，若也吃
// concurrent / 冷卻，整段期間所有一般世界事件都會被鎖死；反過來它自己也不該
// 被一般事件的並發數擋住。所以兩邊在計數時互相排除。
async function tryOpenEvent(client, eventId) {
  if (!isEnabled()) return { opened: false, reason: "disabled" };
  if (!client?.worldEventsCollection) return { opened: false, reason: "disabled" };

  const def = eventDef(eventId);
  if (!def) return { opened: false, reason: "unknown_event" };
  const mainline = isMainline(def);

  const active = await getActiveEvents(client);
  const collecting = active.filter(
    (e) => e.state === "collecting" && isMainline(eventDef(e.event_id)) === mainline,
  ).length;
  const limit = mainline ? 1 : concurrent();
  if (collecting >= limit) return { opened: false, reason: "concurrent_full" };

  if (!mainline) {
    if (await isOnGlobalCooldown(client)) return { opened: false, reason: "global_cooldown" };
    if (await isOnCooldown(client, eventId)) return { opened: false, reason: "cooldown" };
  }

  const now = new Date();
  const windowMs = mainline
    ? (def.collectWindowHoursOverride || 336) * 3600 * 1000
    : collectWindowMs();
  const endsAt = new Date(now.getTime() + windowMs);

  const doc = {
    event_db_id: newEventDbId(),
    event_id: eventId,
    kind: def.kind || "buff",
    state: "collecting",
    started_at: now,
    ends_at: endsAt,
    requirements_remaining: { ...(def.requirements || {}) },
    requirements_total: { ...(def.requirements || {}) },
    daily_limits: { ...(def.dailyLimits || {}) },
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

  // 主線活動的參與門檻：得先打造拓荒錘（防洗頻，也讓「準備階段」本身是個小目標）
  if (event.kind === "mainline") {
    const p = await client.miningProfilesCollection
      .findOne({ userId, guildId }, { projection: { pioneer_hammer: 1 } })
      .catch(() => null);
    if (!p?.pioneer_hammer) return { ok: false, reason: "no_pioneer_hammer" };
  }

  const remaining = (event.requirements_remaining || {})[itemId] || 0;
  if (remaining <= 0) return { ok: false, reason: "no_more_needed", item_id: itemId };
  let actualQty = Math.min(qty, remaining);

  // 每日投入上限（主線活動用）：擋住少數大戶一天清空進度條。
  // 直接對既有的貢獻明細做 aggregate，不必另存欄位。
  const dailyLimit = (event.daily_limits || {})[itemId] || 0;
  if (dailyLimit > 0) {
    const usedToday = await donatedTodayBy(client, { eventDbId, userId, itemId });
    const room = Math.max(0, dailyLimit - usedToday);
    if (room <= 0) {
      return { ok: false, reason: "daily_limit", item_id: itemId, limit: dailyLimit, usedToday };
    }
    actualQty = Math.min(actualQty, room);
  }

  // 逼幣：不走背包 / 倉庫，直接從錢包原子扣款
  if (itemId === CURRENCY_ITEM) {
    return donateCoins(client, { userId, guildId, event, eventDbId, amount: actualQty });
  }

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

  return applyProgress(client, {
    eventDbId, itemId, actualQty, userId, guildId,
    fromPersonal: takeFromPersonal,
    fromGuild: takeFromGuild,
    rollback: async () => {
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
    },
  });
}

// 推進進度 + 寫貢獻明細 + 達標判定。資源已由呼叫端扣好（背包 / 倉庫 / 錢包），
// 進度更新若輸掉競態就呼叫 rollback() 把資源還回去。
async function applyProgress(client, {
  eventDbId, itemId, actualQty, userId, guildId,
  fromPersonal = 0, fromGuild = 0, fromCoins = 0, rollback,
}) {
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
    await rollback?.();
    return { ok: false, reason: "event_progress_race" };
  }

  await client.worldEventContributionsCollection.insertOne({
    event_db_id: eventDbId,
    event_id: updDoc.event_id,
    user_id: userId,
    guild_id: guildId,
    item_id: itemId,
    qty: actualQty,
    from_personal: fromPersonal,
    from_guild: fromGuild,
    from_coins: fromCoins,
    created_at: new Date(),
  }).catch(() => {});

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
      // 主線活動達標 → 依貢獻量發稱號（fire-and-forget，不擋捐獻回應）
      if (updDoc.kind === "mainline") {
        awardContributionTitles(client, updDoc, guildId).catch((e) =>
          console.log(`[WORLD_EVENT] 發稱號失敗：${e.message}`.yellow),
        );
      }
      // 主線活動達標 → 寫入永久解鎖旗標（不是會過期的 buff）
      for (const flag of eventDef(updDoc.event_id)?.unlocks || []) {
        await client.serverFlagsCollection
          ?.updateOne(
            { guildId, key: flag },
            { $set: { value: true, unlocked_at: new Date(), event_db_id: eventDbId } },
            { upsert: true },
          )
          .catch(() => {});
      }
    }
  }

  return {
    ok: true,
    event: updDoc,
    deposited: actualQty,
    fromPersonal,
    fromGuild,
    fromCoins,
    buffStarted,
    buffEndsAt,
    completed,
  };
}

// 主線活動達標後依貢獻量發稱號。
// 門檻用「佔總目標的百分比」定義，這樣總目標之後被調整（例如依實際庫存重新定案）
// 時，門檻會自動等比縮放，不必回頭改 titles.json。
async function awardContributionTitles(client, event, guildId) {
  const { gameTitles } = require("../../config");
  const gameTitleService = require("../gameTitles/gameTitleService");
  if (!client?.worldEventContributionsCollection) return { granted: 0 };

  const totalGoal = Object.values(event.requirements_total || {}).reduce((a, b) => a + b, 0);
  if (!totalGoal) return { granted: 0 };

  const rows = await contributionRanking(client, event.event_db_id, { limit: 500 });
  const defs = Object.entries(gameTitles?.defs || {}).filter(
    ([, d]) => d.req?.contributionPct || d.req?.contributionRank,
  );

  let granted = 0;
  for (const [idx, row] of rows.entries()) {
    const pct = (row.total / totalGoal) * 100;
    for (const [titleId, def] of defs) {
      const okPct = def.req.contributionPct && pct >= def.req.contributionPct;
      const okRank = def.req.contributionRank && idx < def.req.contributionRank;
      if (!okPct && !okRank) continue;
      const r = await gameTitleService
        .grant(client, { userId: row._id, guildId, titleId, source: "world_event" })
        .catch(() => null);
      if (r?.newlyAdded) granted++;
    }
  }
  return { granted };
}

// 管理員手動收掉一個事件（主線活動沒有 trigger，開跟關都靠指令）。
// 直接標成 ended，交由 scheduler 的公告流程收尾。
async function forceEndEvent(client, eventDbId) {
  if (!client?.worldEventsCollection) return { ok: false, reason: "disabled" };
  const now = new Date();
  const upd = await client.worldEventsCollection.findOneAndUpdate(
    { event_db_id: eventDbId, state: { $in: ["collecting", "buffing"] } },
    { $set: { state: "ended", ended_at: now, updated_at: now } },
    { returnDocument: "after" }
  );
  const doc = upd?.value || upd;
  if (!doc) return { ok: false, reason: "not_active" };
  await worldEventBuffs.refreshCache(client).catch(() => {});
  return { ok: true, event: doc };
}

// 主線活動的貢獻排行（發稱號、公告前 N 名用）。
async function contributionRanking(client, eventDbId, { itemId, limit = 10 } = {}) {
  if (!client?.worldEventContributionsCollection) return [];
  const match = { event_db_id: eventDbId };
  if (itemId) match.item_id = itemId;
  return await client.worldEventContributionsCollection
    .aggregate([
      { $match: match },
      { $group: { _id: "$user_id", total: { $sum: "$qty" } } },
      { $sort: { total: -1 } },
      { $limit: limit },
    ])
    .toArray()
    .catch(() => []);
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
  donatedTodayBy,
  isMainline,
  CURRENCY_ITEM,
  forceEndEvent,
  contributionRanking,
  awardContributionTitles,
  settleExpired,
};
