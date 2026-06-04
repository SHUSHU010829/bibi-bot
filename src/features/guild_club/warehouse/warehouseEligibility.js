const { guildWarehouse } = require("../../../config");
const { dayKeyOf, resolveSettings } = require("./warehouseSettings");

const checkUnlockLevel = (club) => {
  const need = guildWarehouse?.unlockLevel || 2;
  if ((club?.level || 1) < need) {
    return { ok: false, reason: "club_level_locked", need, have: club?.level || 1 };
  }
  return { ok: true };
};

const checkTenure = (membership, club) => {
  const { tenureHours } = resolveSettings(club);
  const joinedAt = new Date(membership.joined_at).getTime();
  const elapsedMs = Date.now() - joinedAt;
  const needMs = tenureHours * 3600 * 1000;
  if (elapsedMs < needMs) {
    return {
      ok: false,
      reason: "tenure_not_enough",
      needHours: tenureHours,
      haveHours: Math.floor(elapsedMs / 3600000),
      readyAt: joinedAt + needMs,
    };
  }
  return { ok: true };
};

const checkContribution = (membership, club) => {
  const { minContribution } = resolveSettings(club);
  const have = (membership.total_donated || 0)
    + (membership.warehouse_donated_value || 0);
  if (have < minContribution) {
    return {
      ok: false,
      reason: "contribution_not_enough",
      need: minContribution,
      have,
    };
  }
  return { ok: true };
};

const getDailyDoc = (client, userId, guildId) =>
  client.guildClubWarehouseDailyCollection.findOne({
    user_id: userId,
    guildId,
    day_key: dayKeyOf(),
  });

const checkDailyLimit = async (client, { userId, guildId }, club, itemId) => {
  const { dailyMaxTimes } = resolveSettings(club);
  const doc = await getDailyDoc(client, userId, guildId);
  const taken = doc?.items_taken || [];
  const used = doc?.times_used || 0;
  if (used >= dailyMaxTimes) {
    return {
      ok: false,
      reason: "daily_limit_reached",
      used,
      max: dailyMaxTimes,
    };
  }
  if (taken.includes(itemId)) {
    return { ok: false, reason: "item_already_taken_today", item_id: itemId };
  }
  return { ok: true, used, max: dailyMaxTimes };
};

const checkSelfDepositLock = async (client, { userId }, itemId) => {
  const sinceMs = guildWarehouse?.selfDepositLockMs || 86400000;
  const since = new Date(Date.now() - sinceMs);
  const recent = await client.guildClubWarehouseLogsCollection.findOne({
    user_id: userId,
    item_id: itemId,
    action: "deposit",
    created_at: { $gte: since },
  });
  if (recent) {
    return {
      ok: false,
      reason: "self_deposit_24h_lock",
      qty: recent.qty,
      unlock_at: new Date(recent.created_at).getTime() + sinceMs,
    };
  }
  return { ok: true };
};

module.exports = {
  checkUnlockLevel,
  checkTenure,
  checkContribution,
  checkDailyLimit,
  checkSelfDepositLock,
  getDailyDoc,
};
