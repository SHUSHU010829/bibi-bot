require("colors");
const crypto = require("crypto");
const { guildClub } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const guildClubChat = require("./guildClubChat");

const newGuildClubId = () =>
  `gc_${crypto.randomBytes(4).toString("hex")}`;

const levelDef = (lv) =>
  guildClub.levels.find((l) => l.level === lv) || guildClub.levels[0];

const maxLevel = () =>
  guildClub.levels[guildClub.levels.length - 1].level;

const computeMaxMembers = (lv) => levelDef(lv).maxMembers;

const nextLevelDef = (currentLv) =>
  guildClub.levels.find((l) => l.level === currentLv + 1) || null;

const antiLaunderingCfg = () => guildClub?.antiLaundering || {};

const isManager = (role) => role === "leader" || role === "vice_leader";

// 取得擴充欄位的安全 fallback（舊公會沒有 buildings/forge_level 欄位時用）
const buildingsOf = (club) => ({
  mine: club?.buildings?.mine || 0,
  harbor: club?.buildings?.harbor || 0,
  training: club?.buildings?.training || 0,
  warehouse: club?.buildings?.warehouse || 0,
  farm_kitchen: club?.buildings?.farm_kitchen || 0,
  blacksmith: club?.buildings?.blacksmith || 0,
});
const forgeLevelOf = (club) => club?.forge_level || 0;
const refineryLevelOf = (club) => club?.refinery_level || 0;

const descriptionMaxLength = () =>
  guildClub?.description?.maxLength || 500;

const hoursToMs = (h) => (h || 0) * 3600 * 1000;

// 防洗錢冷卻：由 user_id + source 在 logs 中查最後一筆事件時間
const findLastCooldownLog = async (client, { userId, source }) =>
  client.guildClubLogsCollection.findOne(
    { user_id: userId, source },
    { sort: { createdAt: -1 } }
  );

// 在金庫操作前呼叫：把過期的鎖定條目搬回可分配池
const settleLockedTreasury = async (client, club) => {
  if (!club) return club;
  const entries = Array.isArray(club.locked_entries) ? club.locked_entries : [];
  if (entries.length === 0) return club;
  const now = Date.now();
  const expired = entries.filter((e) => new Date(e.unlocksAt).getTime() <= now);
  if (expired.length === 0) return club;
  const remaining = entries.filter(
    (e) => new Date(e.unlocksAt).getTime() > now
  );
  const releasedAmount = expired.reduce((s, e) => s + (e.amount || 0), 0);
  if (releasedAmount <= 0) return club;
  const updated = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: club.guild_club_id, disbanded_at: null },
    {
      $set: { locked_entries: remaining, updated_at: new Date() },
      $inc: { treasury_locked: -releasedAmount, treasury_current: releasedAmount },
    },
    { returnDocument: "after" }
  );
  const updDoc = updated?.value || updated;
  if (updDoc) {
    await client.guildClubLogsCollection.insertOne({
      guild_club_id: club.guild_club_id,
      user_id: null,
      amount: releasedAmount,
      source: "quest_reward_unlock",
      meta: { entries: expired.length },
      createdAt: new Date(),
    });
  }
  return updDoc || club;
};

const validateName = (raw) => {
  const trimmed = (raw || "").trim();
  const { minLength = 1, maxLength = 12, forbiddenChars = [] } =
    guildClub?.name || {};
  if (trimmed.length < minLength)
    return { ok: false, reason: "name_too_short", min: minLength };
  if (trimmed.length > maxLength)
    return { ok: false, reason: "name_too_long", max: maxLength };
  const hit = forbiddenChars.find((c) => trimmed.includes(c));
  if (hit)
    return { ok: false, reason: "name_forbidden_char", char: hit, all: forbiddenChars };
  return { ok: true, name: trimmed };
};

const getMembership = (client, userId, guildId) =>
  client.guildClubMembersCollection.findOne({ userId, guildId });

const getClubById = (client, guild_club_id) =>
  client.guildsClubCollection.findOne({ guild_club_id, disbanded_at: null });

const getClubByName = (client, guildId, name) =>
  client.guildsClubCollection.findOne({ guildId, name, disbanded_at: null });

const listMembers = (client, guild_club_id) =>
  client.guildClubMembersCollection
    .find({ guild_club_id })
    .sort({ joined_at: 1 })
    .toArray();

const create = async (client, { userId, guildId, name, member }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };

  const nameCheck = validateName(name);
  if (!nameCheck.ok) return nameCheck;

  const existing = await getMembership(client, userId, guildId);
  if (existing) return { ok: false, reason: "already_in_club", membership: existing };

  // 解散後重建冷卻：避免反覆「建立 → 拉人頭 → 解散 → 分錢」洗錢循環
  const recreateMs = hoursToMs(antiLaunderingCfg().recreateCooldownHours);
  if (recreateMs > 0) {
    const lastDisband = await findLastCooldownLog(client, {
      userId,
      source: "disbanded_as_leader",
    });
    if (lastDisband) {
      const readyAt = new Date(lastDisband.createdAt).getTime() + recreateMs;
      if (Date.now() < readyAt) {
        return { ok: false, reason: "recreate_cooldown", readyAt };
      }
    }
  }

  const dup = await getClubByName(client, guildId, nameCheck.name);
  if (dup) return { ok: false, reason: "name_taken" };

  const cost = guildClub.createCost;
  const coinDoc = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = coinDoc?.totalCoins || 0;
  if (balance < cost)
    return { ok: false, reason: "insufficient_funds", need: cost, have: balance };

  const charge = await grantCoins(client, {
    userId,
    guildId,
    member,
    amount: -cost,
    source: "guild_create",
    meta: { name: nameCheck.name },
  });
  if (!charge) return { ok: false, reason: "charge_failed" };

  const now = new Date();
  const guild_club_id = newGuildClubId();
  const lv1 = levelDef(1);
  const doc = {
    guild_club_id,
    guildId,
    name: nameCheck.name,
    leader_id: userId,
    treasury: 0,
    treasury_current: 0,
    treasury_locked: 0,
    locked_entries: [],
    level: 1,
    max_members: lv1.maxMembers,
    description: null,
    forge_level: 0,
    refinery_level: 0,
    buildings: { mine: 0, training: 0, warehouse: 0 },
    created_at: now,
    disbanded_at: null,
    updated_at: now,
  };

  try {
    await client.guildsClubCollection.insertOne(doc);
  } catch (e) {
    await grantCoins(client, {
      userId,
      guildId,
      member,
      amount: cost,
      source: "guild_create_refund",
      meta: { name: nameCheck.name, error: e.message },
    });
    return { ok: false, reason: "insert_failed", error: e.message };
  }

  try {
    await client.guildClubMembersCollection.insertOne({
      guild_club_id,
      userId,
      guildId,
      role: "leader",
      joined_at: now,
      total_donated: 0,
    });
  } catch (e) {
    // 已扣費但成員寫入失敗：標記公會解散，退費
    await client.guildsClubCollection.updateOne(
      { guild_club_id },
      { $set: { disbanded_at: now, updated_at: now } }
    );
    await grantCoins(client, {
      userId,
      guildId,
      member,
      amount: cost,
      source: "guild_create_refund",
      meta: { name: nameCheck.name, error: e.message },
    });
    return { ok: false, reason: "member_insert_failed", error: e.message };
  }

  await client.guildClubLogsCollection.insertOne({
    guild_club_id,
    user_id: userId,
    amount: 0,
    source: "create_grant",
    meta: { cost },
    createdAt: now,
  });

  guildClubChat
    .addMemberWithWelcome(client, { club: doc, userId, source: "create" })
    .catch(() => {});

  return { ok: true, club: doc, cost };
};

// 解散時，過濾出符合「入會時間門檻」的成員（防拉人頭分錢）
const eligibleForPayout = (members, minTenureMs) => {
  if (!minTenureMs || minTenureMs <= 0) return members;
  const cutoff = Date.now() - minTenureMs;
  return members.filter((m) => {
    const joined = m.joined_at ? new Date(m.joined_at).getTime() : 0;
    return joined > 0 && joined <= cutoff;
  });
};

const disband = async (client, { userId, guildId, member }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };

  const m = await getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (m.role !== "leader") return { ok: false, reason: "not_leader" };

  let club = await getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  // 新建公會冷靜期：公會剛成立 N 小時內不能解散，避免快速建→拉人→解散洗錢
  const graceMs = hoursToMs(antiLaunderingCfg().newClubGracePeriodHours);
  if (graceMs > 0 && club.created_at) {
    const readyAt = new Date(club.created_at).getTime() + graceMs;
    if (Date.now() < readyAt) {
      return { ok: false, reason: "grace_period", readyAt };
    }
  }

  // 先把已過期的鎖定條目搬到 current，剩下的 locked 會被沒收
  club = await settleLockedTreasury(client, club);

  const now = new Date();
  const before = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: club.guild_club_id, disbanded_at: null },
    { $set: { disbanded_at: now, updated_at: now } },
    { returnDocument: "before" }
  );
  const beforeDoc = before?.value || before;
  if (!beforeDoc) return { ok: false, reason: "already_disbanded" };

  const allMembers = await listMembers(client, club.guild_club_id);
  const memberCount = allMembers.length;
  const tenureMs = hoursToMs(antiLaunderingCfg().memberPayoutMinTenureHours);
  const eligibleMembers = eligibleForPayout(allMembers, tenureMs);
  const ineligibleMembers = allMembers.filter(
    (mem) => !eligibleMembers.includes(mem)
  );
  const eligibleCount = eligibleMembers.length;
  const treasury = beforeDoc.treasury_current || 0;
  const lockedForfeit = beforeDoc.treasury_locked || 0;
  const payoutPerMember =
    eligibleCount > 0 ? Math.floor(treasury / eligibleCount) : 0;
  const totalPaid = payoutPerMember * eligibleCount;

  const payouts = [];
  if (payoutPerMember > 0) {
    for (const mem of eligibleMembers) {
      const memberEntity = mem.userId === userId ? member : null;
      const granted = await grantCoins(client, {
        userId: mem.userId,
        guildId,
        member: memberEntity,
        amount: payoutPerMember,
        source: "guild_disband_payout",
        meta: { guild_club_id: club.guild_club_id, name: club.name },
      });
      payouts.push({
        userId: mem.userId,
        granted: granted?.granted ?? payoutPerMember,
      });
    }
    await client.guildClubLogsCollection.insertOne({
      guild_club_id: club.guild_club_id,
      user_id: null,
      amount: -totalPaid,
      source: "disband_payout",
      meta: { payoutPerMember, eligibleCount, totalMembers: memberCount },
      createdAt: now,
    });
  }

  if (lockedForfeit > 0) {
    await client.guildClubLogsCollection.insertOne({
      guild_club_id: club.guild_club_id,
      user_id: null,
      amount: -lockedForfeit,
      source: "quest_reward_forfeit",
      meta: { reason: "disband_before_unlock" },
      createdAt: now,
    });
  }

  // 寫入冷卻標記 log（重建冷卻會查這筆）
  await client.guildClubLogsCollection.insertOne({
    guild_club_id: club.guild_club_id,
    user_id: userId,
    amount: 0,
    source: "disbanded_as_leader",
    meta: { name: club.name },
    createdAt: now,
  });

  await client.guildsClubCollection.updateOne(
    { guild_club_id: club.guild_club_id },
    {
      $set: {
        treasury_current: Math.max(0, treasury - totalPaid),
        treasury_locked: 0,
        locked_entries: [],
      },
    }
  );
  await client.guildClubMembersCollection.deleteMany({
    guild_club_id: club.guild_club_id,
  });

  guildClubChat.archiveOnDisband(client, beforeDoc).catch(() => {});

  return {
    ok: true,
    club: beforeDoc,
    payoutPerMember,
    memberCount,
    eligibleCount,
    ineligibleCount: ineligibleMembers.length,
    payouts,
    remainder: Math.max(0, treasury - totalPaid),
    lockedForfeit,
  };
};

// 嘗試升一級（一次只升一級）。在跨越多個門檻時，回傳 crossedThresholds 給呼叫端
// 做廣播文案；剩餘金額已寫入 treasury，下次任何金庫變動會再次觸發。
const checkLevelUp = async (client, currentDoc, opts = {}) => {
  const next = nextLevelDef(currentDoc.level);
  if (!next) return null;
  if ((currentDoc.treasury || 0) < next.threshold) return null;

  const upd = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: currentDoc.guild_club_id, level: currentDoc.level },
    {
      $set: {
        level: next.level,
        max_members: next.maxMembers,
        updated_at: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  const updDoc = upd?.value || upd;
  if (!updDoc) return null;

  return {
    club: updDoc,
    fromLevel: currentDoc.level,
    toLevel: next.level,
    crossedThresholds: opts.crossedThresholds || 1,
  };
};

const donate = async (client, { userId, guildId, member, amount }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };
  if (!Number.isInteger(amount) || amount <= 0)
    return { ok: false, reason: "invalid_amount" };

  const m = await getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };

  // 進金庫前先把過期鎖定條目搬到 current，讓 levelUp 判斷與顯示一致
  const preClub = await getClubById(client, m.guild_club_id);
  if (preClub) await settleLockedTreasury(client, preClub);

  const coinDoc = await client.userCoinsCollection.findOne({ userId, guildId });
  const balance = coinDoc?.totalCoins || 0;
  if (balance < amount)
    return { ok: false, reason: "insufficient_funds", need: amount, have: balance };

  const charge = await grantCoins(client, {
    userId,
    guildId,
    member,
    amount: -amount,
    source: "guild_donate",
    meta: { guild_club_id: m.guild_club_id },
  });
  if (!charge) return { ok: false, reason: "charge_failed" };

  const now = new Date();
  const updated = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: m.guild_club_id, disbanded_at: null },
    {
      $inc: { treasury: amount, treasury_current: amount },
      $set: { updated_at: now },
    },
    { returnDocument: "after" }
  );
  const updatedDoc = updated?.value || updated;
  if (!updatedDoc) {
    // 公會在扣費後解散：退款
    await grantCoins(client, {
      userId,
      guildId,
      member,
      amount,
      source: "guild_donate_refund",
      meta: { guild_club_id: m.guild_club_id },
    });
    return { ok: false, reason: "club_missing" };
  }

  await client.guildClubMembersCollection.updateOne(
    { userId, guildId, guild_club_id: m.guild_club_id },
    { $inc: { total_donated: amount } }
  );
  await client.guildClubLogsCollection.insertOne({
    guild_club_id: m.guild_club_id,
    user_id: userId,
    amount,
    source: "donate",
    meta: {},
    createdAt: now,
  });

  const oldTreasury = (updatedDoc.treasury || 0) - amount;
  const oldLevel = updatedDoc.level;
  const crossedThresholds = guildClub.levels.filter(
    (l) =>
      l.level > oldLevel &&
      l.threshold > oldTreasury &&
      l.threshold <= (updatedDoc.treasury || 0)
  ).length;

  const levelUp = await checkLevelUp(client, updatedDoc, { crossedThresholds });

  const memberAfter = await getMembership(client, userId, guildId);

  return {
    ok: true,
    club: levelUp?.club || updatedDoc,
    donated: amount,
    totalDonated: memberAfter?.total_donated || amount,
    levelUp,
  };
};

const setDescription = async (
  client,
  { userId, guildId, description }
) => {
  const m = await getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (!isManager(m.role)) return { ok: false, reason: "not_manager" };

  const club = await getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const max = descriptionMaxLength();
  const raw = typeof description === "string" ? description : "";
  const trimmed = raw.replace(/\r/g, "").trim();
  if (trimmed.length > max)
    return { ok: false, reason: "description_too_long", max, length: trimmed.length };

  const next = trimmed.length === 0 ? null : trimmed;
  const updated = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: club.guild_club_id, disbanded_at: null },
    { $set: { description: next, updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const doc = updated?.value || updated;
  if (!doc) return { ok: false, reason: "club_missing" };

  return { ok: true, club: doc, cleared: next === null, role: m.role };
};

module.exports = {
  validateName,
  newGuildClubId,
  levelDef,
  maxLevel,
  computeMaxMembers,
  nextLevelDef,
  getMembership,
  getClubById,
  getClubByName,
  listMembers,
  create,
  disband,
  donate,
  checkLevelUp,
  settleLockedTreasury,
  findLastCooldownLog,
  eligibleForPayout,
  hoursToMs,
  antiLaunderingCfg,
  isManager,
  setDescription,
  descriptionMaxLength,
  buildingsOf,
  forgeLevelOf,
  refineryLevelOf,
};
