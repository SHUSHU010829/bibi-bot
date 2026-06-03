require("colors");
const crypto = require("crypto");
const { guildClub } = require("../../config");
const grantCoins = require("../economy/grantCoins");

const newGuildClubId = () =>
  `gc_${crypto.randomBytes(4).toString("hex")}`;

const levelDef = (lv) =>
  guildClub.levels.find((l) => l.level === lv) || guildClub.levels[0];

const maxLevel = () =>
  guildClub.levels[guildClub.levels.length - 1].level;

const computeMaxMembers = (lv) => levelDef(lv).maxMembers;

const nextLevelDef = (currentLv) =>
  guildClub.levels.find((l) => l.level === currentLv + 1) || null;

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
    level: 1,
    max_members: lv1.maxMembers,
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

  return { ok: true, club: doc, cost };
};

const disband = async (client, { userId, guildId, member }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };

  const m = await getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (m.role !== "leader") return { ok: false, reason: "not_leader" };

  const club = await getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const now = new Date();
  // 原子標記解散，並發呼叫只會有一個贏家
  const before = await client.guildsClubCollection.findOneAndUpdate(
    { guild_club_id: club.guild_club_id, disbanded_at: null },
    { $set: { disbanded_at: now, updated_at: now } },
    { returnDocument: "before" }
  );
  const beforeDoc = before?.value || before; // driver 版本相容
  if (!beforeDoc) return { ok: false, reason: "already_disbanded" };

  const members = await listMembers(client, club.guild_club_id);
  const memberCount = members.length;
  const treasury = beforeDoc.treasury_current || 0;
  const payoutPerMember =
    memberCount > 0 ? Math.floor(treasury / memberCount) : 0;
  const totalPaid = payoutPerMember * memberCount;

  const payouts = [];
  if (payoutPerMember > 0) {
    for (const mem of members) {
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
      meta: { payoutPerMember, memberCount },
      createdAt: now,
    });
  }

  await client.guildsClubCollection.updateOne(
    { guild_club_id: club.guild_club_id },
    { $set: { treasury_current: Math.max(0, treasury - totalPaid) } }
  );
  await client.guildClubMembersCollection.deleteMany({
    guild_club_id: club.guild_club_id,
  });

  return {
    ok: true,
    club: beforeDoc,
    payoutPerMember,
    memberCount,
    payouts,
    remainder: Math.max(0, treasury - totalPaid),
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
};
