require("colors");
const { guildWarehouse } = require("../../../config");
const grantCoins = require("../../economy/grantCoins");
const guildClubService = require("../guildClubService");
const {
  itemDef,
  allItemIds,
  capacityFor,
  perTakeMaxFor,
  resolveSettings,
  calcFee,
  marketValue,
  contributionFromDeposit,
  dayKeyOf,
} = require("./warehouseSettings");
const {
  checkUnlockLevel,
  checkTenure,
  checkContribution,
  checkDailyLimit,
  checkSelfDepositLock,
} = require("./warehouseEligibility");

const PROFILE = "miningProfilesCollection";

const BAG_BY_KIND = { fish_bag: "fish_bag", veggie_bag: "veggie_bag" };
const bagFieldFor = (def) => BAG_BY_KIND[def.kind] || "backpack";

const fieldForItem = (def) => `${bagFieldFor(def)}.${def._id}`;

const enriched = (itemId) => {
  const d = itemDef(itemId);
  return d ? { ...d, _id: itemId } : null;
};

// 把已到期的 pending 批次合併到 available_qty。回傳更新後 doc。
const sweepProtection = async (client, guildClubId, itemId) => {
  const now = Date.now();
  const row = await client.guildClubWarehouseCollection.findOne({
    guild_club_id: guildClubId,
    item_id: itemId,
  });
  if (!row) return null;
  const pending = Array.isArray(row.pending) ? row.pending : [];
  if (pending.length === 0) return row;
  const stillPending = pending.filter(
    (p) => new Date(p.available_at).getTime() > now
  );
  if (stillPending.length === pending.length) return row;
  const released = pending
    .filter((p) => new Date(p.available_at).getTime() <= now)
    .reduce((s, p) => s + (p.qty || 0), 0);
  if (released <= 0) {
    await client.guildClubWarehouseCollection.updateOne(
      { _id: row._id },
      { $set: { pending: stillPending, updated_at: new Date() } }
    );
    return { ...row, pending: stillPending };
  }
  await client.guildClubWarehouseCollection.updateOne(
    { _id: row._id },
    {
      $set: { pending: stillPending, updated_at: new Date() },
      $inc: { available_qty: released },
    }
  );
  return {
    ...row,
    pending: stillPending,
    available_qty: (row.available_qty || 0) + released,
  };
};

const sweepAll = async (client, guildClubId) => {
  for (const id of allItemIds()) {
    await sweepProtection(client, guildClubId, id).catch(() => {});
  }
};

const getInventory = async (client, guildClubId) => {
  await sweepAll(client, guildClubId);
  const rows = await client.guildClubWarehouseCollection
    .find({ guild_club_id: guildClubId })
    .toArray();
  const byId = {};
  for (const r of rows) byId[r.item_id] = r;
  return allItemIds().map((id) => {
    const r = byId[id] || {};
    const protectedQty = (r.pending || []).reduce(
      (s, p) => s + (p.qty || 0),
      0
    );
    return {
      item_id: id,
      def: enriched(id),
      qty: r.qty || 0,
      available_qty: r.available_qty || 0,
      protected_qty: protectedQty,
      next_unlock_at:
        protectedQty > 0
          ? Math.min(
              ...(r.pending || []).map((p) => new Date(p.available_at).getTime())
            )
          : null,
    };
  });
};

const deposit = async (
  client,
  { userId, guildId, member, itemId, qty }
) => {
  if (!guildWarehouse?.enabled) return { ok: false, reason: "disabled" };
  const def = enriched(itemId);
  if (!def) return { ok: false, reason: "unknown_item" };
  if (def.craftedOnly) return { ok: false, reason: "crafted_only_no_deposit" };
  if (!Number.isInteger(qty) || qty <= 0)
    return { ok: false, reason: "invalid_qty" };

  const m = await guildClubService.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };

  const club = await guildClubService.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const lock = checkUnlockLevel(club);
  if (!lock.ok) return lock;

  const profile = await client[PROFILE].findOne({ userId, guildId });
  const haveField = bagFieldFor(def);
  const have = profile?.[haveField]?.[itemId] || 0;
  if (have < qty)
    return { ok: false, reason: "not_enough_in_pack", have, need: qty, kind: def.kind };

  await sweepProtection(client, m.guild_club_id, itemId);
  const row = await client.guildClubWarehouseCollection.findOne({
    guild_club_id: m.guild_club_id,
    item_id: itemId,
  });
  const cap = capacityFor(itemId, club.level, club.warehouse_settings, club);
  const currentTotal = row?.qty || 0;
  if (currentTotal + qty > cap)
    return {
      ok: false,
      reason: "capacity_exceeded",
      have: currentTotal,
      cap,
      add: qty,
    };

  const decRes = await client[PROFILE].updateOne(
    {
      userId,
      guildId,
      [`${haveField}.${itemId}`]: { $gte: qty },
    },
    {
      $inc: { [`${haveField}.${itemId}`]: -qty },
      $set: { updatedAt: new Date() },
    }
  );
  if (decRes.modifiedCount === 0)
    return { ok: false, reason: "race_lost_pack" };

  const now = new Date();
  const availableAt = new Date(now.getTime() + (guildWarehouse.protectionMs || 0));
  const pendingEntry = { qty, available_at: availableAt, depositor_id: userId };

  try {
    await client.guildClubWarehouseCollection.updateOne(
      { guild_club_id: m.guild_club_id, item_id: itemId },
      {
        $setOnInsert: {
          guild_club_id: m.guild_club_id,
          item_id: itemId,
          available_qty: 0,
        },
        $inc: { qty },
        $push: { pending: pendingEntry },
        $set: { updated_at: now },
      },
      { upsert: true }
    );
  } catch (e) {
    await client[PROFILE].updateOne(
      { userId, guildId },
      {
        $inc: { [`${haveField}.${itemId}`]: qty },
        $set: { updatedAt: new Date() },
      }
    ).catch(() => {});
    return { ok: false, reason: "warehouse_write_failed" };
  }

  const value = marketValue(itemId, qty);
  const contribution = contributionFromDeposit(itemId, qty);

  await client.guildClubMembersCollection.updateOne(
    { userId, guildId, guild_club_id: m.guild_club_id },
    { $inc: { warehouse_donated_value: value } }
  ).catch(() => {});

  await client.guildClubWarehouseLogsCollection.insertOne({
    guild_club_id: m.guild_club_id,
    user_id: userId,
    action: "deposit",
    item_id: itemId,
    qty,
    fee: 0,
    market_value: value,
    created_at: now,
  });

  const totalNow = (row?.qty || 0) + qty;
  return {
    ok: true,
    club,
    item: def,
    deposited: qty,
    new_total: totalNow,
    capacity: cap,
    available_at: availableAt,
    market_value: value,
    contribution_added: contribution,
    large_announce:
      value >= (guildWarehouse.largeDepositAnnounceValue || Infinity),
  };
};

const upsertDaily = async (client, { userId, guildId, itemId }) => {
  const key = dayKeyOf();
  const now = new Date();
  await client.guildClubWarehouseDailyCollection.updateOne(
    { user_id: userId, guildId, day_key: key },
    {
      $setOnInsert: {
        user_id: userId,
        guildId,
        day_key: key,
        guild_club_id: null,
      },
      $addToSet: { items_taken: itemId },
      $inc: { times_used: 1 },
      $set: { updated_at: now },
    },
    { upsert: true }
  );
};

const withdraw = async (
  client,
  { userId, guildId, member, itemId, qty }
) => {
  if (!guildWarehouse?.enabled) return { ok: false, reason: "disabled" };
  const def = enriched(itemId);
  if (!def) return { ok: false, reason: "unknown_item" };
  if (def.craftedOnly) return { ok: false, reason: "crafted_only_no_withdraw" };
  if (!Number.isInteger(qty) || qty <= 0)
    return { ok: false, reason: "invalid_qty" };

  const m = await guildClubService.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };

  const club = await guildClubService.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const lock = checkUnlockLevel(club);
  if (!lock.ok) return lock;

  const tenure = checkTenure(m, club);
  if (!tenure.ok) return tenure;

  const contrib = checkContribution(m, club);
  if (!contrib.ok) return contrib;

  const daily = await checkDailyLimit(client, { userId, guildId }, club, itemId);
  if (!daily.ok) return daily;

  const selfLock = await checkSelfDepositLock(client, { userId }, itemId);
  if (!selfLock.ok) return selfLock;

  const personalCap = perTakeMaxFor(itemId, club.warehouse_settings);
  if (qty > personalCap)
    return { ok: false, reason: "qty_over_personal_limit", limit: personalCap, asked: qty };

  await sweepProtection(client, m.guild_club_id, itemId);
  const row = await client.guildClubWarehouseCollection.findOne({
    guild_club_id: m.guild_club_id,
    item_id: itemId,
  });
  const available = row?.available_qty || 0;
  const total = row?.qty || 0;
  const protectedQty = total - available;
  if (available < qty)
    return {
      ok: false,
      reason: available > 0 ? "qty_over_available" : "warehouse_empty",
      available,
      total,
      protected: protectedQty,
      asked: qty,
    };

  const fee = calcFee(itemId, qty, club);
  const coinDoc = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = coinDoc?.totalCoins || 0;
  if (balance < fee)
    return { ok: false, reason: "insufficient_funds_for_fee", need: fee, have: balance };

  // 1) 原子扣倉庫（搶單防護）
  const dec = await client.guildClubWarehouseCollection.findOneAndUpdate(
    {
      guild_club_id: m.guild_club_id,
      item_id: itemId,
      available_qty: { $gte: qty },
    },
    {
      $inc: { qty: -qty, available_qty: -qty },
      $set: { updated_at: new Date() },
    },
    { returnDocument: "after" }
  );
  const updRow = dec?.value || dec;
  if (!updRow) return { ok: false, reason: "race_lost" };

  // 2) 扣費 → 入金庫
  const charge = await grantCoins(client, {
    userId,
    guildId,
    member,
    amount: -fee,
    source: "guild_warehouse_fee",
    meta: { guild_club_id: m.guild_club_id, item_id: itemId, qty },
  });
  if (!charge) {
    await client.guildClubWarehouseCollection.updateOne(
      { _id: updRow._id },
      { $inc: { qty, available_qty: qty }, $set: { updated_at: new Date() } }
    ).catch(() => {});
    return { ok: false, reason: "charge_failed" };
  }
  await client.guildsClubCollection.updateOne(
    { guild_club_id: m.guild_club_id, disbanded_at: null },
    {
      $inc: { treasury: fee, treasury_current: fee },
      $set: { updated_at: new Date() },
    }
  ).catch(() => {});

  // 3) 加成品到玩家的背包/魚袋/菜籃
  const haveField = bagFieldFor(def);
  await client[PROFILE].updateOne(
    { userId, guildId },
    {
      $inc: { [`${haveField}.${itemId}`]: qty },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  );

  // 4) 寫 log + 每日額度
  const now = new Date();
  await client.guildClubWarehouseLogsCollection.insertOne({
    guild_club_id: m.guild_club_id,
    user_id: userId,
    action: "withdraw",
    item_id: itemId,
    qty,
    fee,
    market_value: marketValue(itemId, qty),
    created_at: now,
  });
  await upsertDaily(client, { userId, guildId, itemId }).catch(() => {});

  return {
    ok: true,
    club,
    item: def,
    withdrawn: qty,
    fee,
    new_total: (updRow.qty || 0),
    new_available: (updRow.available_qty || 0),
    daily_remaining: Math.max(0, daily.max - daily.used - 1),
    daily_max: daily.max,
  };
};

const getNetFlow = async (client, guildClubId, days = 7) => {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const cursor = await client.guildClubWarehouseLogsCollection
    .find({ guild_club_id: guildClubId, created_at: { $gte: since } })
    .project({ action: 1, market_value: 1 })
    .toArray();
  let inFlow = 0;
  let outFlow = 0;
  for (const e of cursor) {
    if (e.action === "deposit") inFlow += e.market_value || 0;
    else outFlow += e.market_value || 0;
  }
  return { inFlow, outFlow, net: inFlow - outFlow };
};

const getSummary = async (client, guildClubId) => {
  const inventory = await getInventory(client, guildClubId);
  const totalValue = inventory.reduce(
    (s, it) => s + marketValue(it.item_id, it.qty),
    0
  );
  const last = await client.guildClubWarehouseLogsCollection
    .find({ guild_club_id: guildClubId })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  const flow = await getNetFlow(client, guildClubId, 7);
  return {
    totalValue,
    lastActivityAt: last[0]?.created_at || null,
    netFlow7d: flow.net,
    inFlow7d: flow.inFlow,
    outFlow7d: flow.outFlow,
  };
};

module.exports = {
  deposit,
  withdraw,
  getInventory,
  sweepProtection,
  sweepAll,
  getNetFlow,
  getSummary,
};
