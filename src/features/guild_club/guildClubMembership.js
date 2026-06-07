require("colors");
const crypto = require("crypto");
const { guildClub } = require("../../config");
const service = require("./guildClubService");
const guildClubDm = require("./guildClubDm");

const shortId = (prefix) =>
  `${prefix}_${crypto.randomBytes(4).toString("hex")}`;

const inviteExpireMs = () =>
  (guildClub?.invitation?.expireHours || 168) * 3600 * 1000;

const applicationExpireMs = () =>
  (guildClub?.application?.expireHours || 168) * 3600 * 1000;

const applicationCooldownMs = () =>
  (guildClub?.application?.rejectCooldownHours || 24) * 3600 * 1000;

const applicationMessageMax = () =>
  guildClub?.application?.messageMaxLength || 100;

// 退會/被踢後再加入冷卻：防止「主帳退會 → alt 加入 → 解散分錢 → 主帳再回鍋」
const checkRejoinCooldown = async (client, userId) => {
  const ms = service.hoursToMs(service.antiLaunderingCfg().rejoinCooldownHours);
  if (!ms || ms <= 0) return null;
  const [leftLog, kickLog] = await Promise.all([
    service.findLastCooldownLog(client, { userId, source: "left_club" }),
    service.findLastCooldownLog(client, { userId, source: "kicked_from_club" }),
  ]);
  const candidates = [leftLog, kickLog].filter(Boolean);
  if (candidates.length === 0) return null;
  const latest = candidates.reduce((a, b) =>
    new Date(a.createdAt) > new Date(b.createdAt) ? a : b
  );
  const readyAt = new Date(latest.createdAt).getTime() + ms;
  if (Date.now() >= readyAt) return null;
  return { readyAt, source: latest.source };
};

// ─── 邀請（會長 → 玩家）────────────────────────────────────

const invite = async (client, { leaderId, guildId, inviteeId }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };
  if (inviteeId === leaderId)
    return { ok: false, reason: "cannot_invite_self" };

  const leaderM = await service.getMembership(client, leaderId, guildId);
  if (!leaderM) return { ok: false, reason: "leader_not_in_club" };
  if (!service.isManager(leaderM.role)) return { ok: false, reason: "not_leader" };

  const club = await service.getClubById(client, leaderM.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const inviteeM = await service.getMembership(client, inviteeId, guildId);
  if (inviteeM) {
    return inviteeM.guild_club_id === club.guild_club_id
      ? { ok: false, reason: "invitee_already_in_this_club" }
      : { ok: false, reason: "invitee_in_other_club" };
  }

  const cd = await checkRejoinCooldown(client, inviteeId);
  if (cd)
    return {
      ok: false,
      reason: "invitee_rejoin_cooldown",
      readyAt: cd.readyAt,
      source: cd.source,
    };

  const members = await service.listMembers(client, club.guild_club_id);
  if (members.length >= club.max_members)
    return { ok: false, reason: "club_full", current: members.length, max: club.max_members };

  const existing = await client.guildClubInvitationsCollection.findOne({
    guild_club_id: club.guild_club_id,
    invitee_id: inviteeId,
    status: "pending",
  });
  if (existing)
    return { ok: false, reason: "already_invited", inviteId: existing.invitation_id };

  const now = new Date();
  const invitation_id = shortId("inv");
  await client.guildClubInvitationsCollection.insertOne({
    invitation_id,
    guild_club_id: club.guild_club_id,
    guildId,
    invitee_id: inviteeId,
    inviter_id: leaderId,
    status: "pending",
    expiresAt: new Date(now.getTime() + inviteExpireMs()),
    createdAt: now,
    respondedAt: null,
  });

  return { ok: true, club, invitation_id };
};

const respondInvitation = async (
  client,
  { userId, guildId, invitation_id, accept }
) => {
  const inv = await client.guildClubInvitationsCollection.findOne({
    invitation_id,
  });
  if (!inv) return { ok: false, reason: "invitation_missing" };
  if (inv.invitee_id !== userId) return { ok: false, reason: "not_invitee" };
  if (inv.status !== "pending")
    return { ok: false, reason: "invitation_not_pending", status: inv.status };
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now())
    return { ok: false, reason: "invitation_expired" };

  if (!accept) {
    const upd = await client.guildClubInvitationsCollection.findOneAndUpdate(
      { invitation_id, status: "pending" },
      { $set: { status: "declined", respondedAt: new Date() } },
      { returnDocument: "after" }
    );
    return { ok: true, accepted: false, invitation: upd?.value || upd };
  }

  // 接受：再次驗證 + 原子更新狀態 → 寫入成員
  const club = await service.getClubById(client, inv.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const existing = await service.getMembership(client, userId, guildId);
  if (existing) return { ok: false, reason: "already_in_club" };

  const cd = await checkRejoinCooldown(client, userId);
  if (cd)
    return {
      ok: false,
      reason: "rejoin_cooldown",
      readyAt: cd.readyAt,
      source: cd.source,
    };

  const members = await service.listMembers(client, club.guild_club_id);
  if (members.length >= club.max_members)
    return { ok: false, reason: "club_full" };

  const acceptedNow = await client.guildClubInvitationsCollection.findOneAndUpdate(
    { invitation_id, status: "pending" },
    { $set: { status: "accepted", respondedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!(acceptedNow?.value || acceptedNow))
    return { ok: false, reason: "race_lost" };

  try {
    await client.guildClubMembersCollection.insertOne({
      guild_club_id: club.guild_club_id,
      userId,
      guildId,
      role: "member",
      joined_at: new Date(),
      total_donated: 0,
    });
  } catch (e) {
    return { ok: false, reason: "member_insert_failed", error: e.message };
  }

  return { ok: true, accepted: true, club };
};

// ─── 申請（玩家 → 會長）────────────────────────────────────

const apply = async (client, { applicantId, guildId, clubName, message }) => {
  if (!guildClub?.enabled) return { ok: false, reason: "disabled" };

  const existing = await service.getMembership(client, applicantId, guildId);
  if (existing) return { ok: false, reason: "already_in_club" };

  const cd = await checkRejoinCooldown(client, applicantId);
  if (cd)
    return {
      ok: false,
      reason: "rejoin_cooldown",
      readyAt: cd.readyAt,
      source: cd.source,
    };

  const club = await service.getClubByName(client, guildId, (clubName || "").trim());
  if (!club) return { ok: false, reason: "club_not_found" };

  const members = await service.listMembers(client, club.guild_club_id);
  if (members.length >= club.max_members)
    return { ok: false, reason: "club_full", current: members.length, max: club.max_members };

  const cooldownStart = new Date(Date.now() - applicationCooldownMs());
  const recentlyRejected = await client.guildClubApplicationsCollection.findOne({
    applicant_id: applicantId,
    guild_club_id: club.guild_club_id,
    status: "rejected",
    respondedAt: { $gte: cooldownStart },
  });
  if (recentlyRejected) {
    const readyAt =
      recentlyRejected.respondedAt.getTime() + applicationCooldownMs();
    return { ok: false, reason: "rejected_cooldown", readyAt };
  }

  const pending = await client.guildClubApplicationsCollection.findOne({
    applicant_id: applicantId,
    guild_club_id: club.guild_club_id,
    status: "pending",
  });
  if (pending)
    return { ok: false, reason: "already_pending", application_id: pending.application_id };

  const trimmedMsg =
    typeof message === "string"
      ? message.trim().slice(0, applicationMessageMax())
      : null;

  const application_id = shortId("app");
  const now = new Date();
  await client.guildClubApplicationsCollection.insertOne({
    application_id,
    guild_club_id: club.guild_club_id,
    guildId,
    applicant_id: applicantId,
    message: trimmedMsg || null,
    status: "pending",
    expiresAt: new Date(now.getTime() + applicationExpireMs()),
    createdAt: now,
    respondedAt: null,
    responded_by: null,
  });

  guildClubDm
    .notifyNewApplication(client, {
      leaderId: club.leader_id,
      guildId,
      applicantId,
      clubName: club.name,
      message: trimmedMsg,
    })
    .catch(() => {});

  return { ok: true, club, application_id };
};

const listPendingApplications = async (
  client,
  { leaderId, guildId }
) => {
  const m = await service.getMembership(client, leaderId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (!service.isManager(m.role)) return { ok: false, reason: "not_leader" };

  const club = await service.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const items = await client.guildClubApplicationsCollection
    .find({ guild_club_id: club.guild_club_id, status: "pending" })
    .sort({ createdAt: 1 })
    .toArray();

  return { ok: true, club, applications: items };
};

const respondApplication = async (
  client,
  { leaderId, guildId, application_id, approve }
) => {
  const m = await service.getMembership(client, leaderId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (!service.isManager(m.role)) return { ok: false, reason: "not_leader" };

  const app = await client.guildClubApplicationsCollection.findOne({
    application_id,
  });
  if (!app) return { ok: false, reason: "application_missing" };
  if (app.guild_club_id !== m.guild_club_id)
    return { ok: false, reason: "not_your_club_application" };
  if (app.status !== "pending")
    return { ok: false, reason: "application_not_pending", status: app.status };

  if (!approve) {
    const upd = await client.guildClubApplicationsCollection.findOneAndUpdate(
      { application_id, status: "pending" },
      {
        $set: {
          status: "rejected",
          respondedAt: new Date(),
          responded_by: leaderId,
        },
      },
      { returnDocument: "after" }
    );
    return { ok: true, approved: false, application: upd?.value || upd };
  }

  const club = await service.getClubById(client, app.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const applicantMembership = await service.getMembership(
    client,
    app.applicant_id,
    guildId
  );
  if (applicantMembership)
    return { ok: false, reason: "applicant_already_in_club" };

  const cd = await checkRejoinCooldown(client, app.applicant_id);
  if (cd)
    return {
      ok: false,
      reason: "applicant_rejoin_cooldown",
      readyAt: cd.readyAt,
      source: cd.source,
    };

  const members = await service.listMembers(client, club.guild_club_id);
  if (members.length >= club.max_members)
    return { ok: false, reason: "club_full" };

  const approved = await client.guildClubApplicationsCollection.findOneAndUpdate(
    { application_id, status: "pending" },
    {
      $set: {
        status: "approved",
        respondedAt: new Date(),
        responded_by: leaderId,
      },
    },
    { returnDocument: "after" }
  );
  if (!(approved?.value || approved))
    return { ok: false, reason: "race_lost" };

  try {
    await client.guildClubMembersCollection.insertOne({
      guild_club_id: club.guild_club_id,
      userId: app.applicant_id,
      guildId,
      role: "member",
      joined_at: new Date(),
      total_donated: 0,
    });
  } catch (e) {
    return { ok: false, reason: "member_insert_failed", error: e.message };
  }

  return { ok: true, approved: true, club, applicantId: app.applicant_id };
};

// ─── 退會 / 踢人 / 轉讓 ────────────────────────────────────

const leave = async (client, { userId, guildId }) => {
  const m = await service.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };

  const club = await service.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  if (m.role === "leader") {
    const members = await service.listMembers(client, m.guild_club_id);
    if (members.length > 1)
      return {
        ok: false,
        reason: "leader_with_members",
        memberCount: members.length,
      };
    // 會長獨自一人：等同解散，由呼叫端引導使用 /公會 解散
    return { ok: false, reason: "leader_must_disband" };
  }

  const allMembers = await service.listMembers(client, m.guild_club_id);
  const managerIds = allMembers
    .filter((mem) => service.isManager(mem.role) && mem.userId !== userId)
    .map((mem) => mem.userId);

  await client.guildClubMembersCollection.deleteOne({
    userId,
    guildId,
    guild_club_id: m.guild_club_id,
  });

  const now = new Date();
  await client.guildClubLogsCollection.insertOne({
    guild_club_id: m.guild_club_id,
    user_id: userId,
    amount: 0,
    source: "left_club",
    meta: {},
    createdAt: now,
  });

  const rejoinMs = service.hoursToMs(
    service.antiLaunderingCfg().rejoinCooldownHours
  );
  const rejoinReadyAt = rejoinMs > 0 ? now.getTime() + rejoinMs : null;

  return { ok: true, club, managerIds, rejoinReadyAt };
};

const kick = async (client, { leaderId, guildId, targetId }) => {
  if (targetId === leaderId) return { ok: false, reason: "cannot_kick_self" };

  const leaderM = await service.getMembership(client, leaderId, guildId);
  if (!leaderM) return { ok: false, reason: "not_in_club" };
  if (!service.isManager(leaderM.role)) return { ok: false, reason: "not_leader" };

  const targetM = await service.getMembership(client, targetId, guildId);
  if (!targetM || targetM.guild_club_id !== leaderM.guild_club_id)
    return { ok: false, reason: "target_not_in_your_club" };

  // 副會長不能踢會長 / 其他副會長
  if (leaderM.role === "vice_leader" && service.isManager(targetM.role))
    return { ok: false, reason: "vice_cannot_kick_manager" };

  const club = await service.getClubById(client, leaderM.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  await client.guildClubMembersCollection.deleteOne({
    userId: targetId,
    guildId,
    guild_club_id: leaderM.guild_club_id,
  });

  await client.guildClubLogsCollection.insertOne({
    guild_club_id: leaderM.guild_club_id,
    user_id: targetId,
    amount: 0,
    source: "kicked_from_club",
    meta: { by: leaderId },
    createdAt: new Date(),
  });

  return { ok: true, club, targetId };
};

const transfer = async (client, { leaderId, guildId, newLeaderId }) => {
  if (newLeaderId === leaderId)
    return { ok: false, reason: "cannot_transfer_to_self" };

  const leaderM = await service.getMembership(client, leaderId, guildId);
  if (!leaderM) return { ok: false, reason: "not_in_club" };
  if (leaderM.role !== "leader") return { ok: false, reason: "not_leader" };

  const targetM = await service.getMembership(client, newLeaderId, guildId);
  if (!targetM || targetM.guild_club_id !== leaderM.guild_club_id)
    return { ok: false, reason: "target_not_in_your_club" };

  const club = await service.getClubById(client, leaderM.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  await client.guildClubMembersCollection.updateOne(
    { userId: newLeaderId, guildId, guild_club_id: club.guild_club_id },
    { $set: { role: "leader" } }
  );
  await client.guildClubMembersCollection.updateOne(
    { userId: leaderId, guildId, guild_club_id: club.guild_club_id },
    { $set: { role: "member" } }
  );
  await client.guildsClubCollection.updateOne(
    { guild_club_id: club.guild_club_id },
    { $set: { leader_id: newLeaderId, updated_at: new Date() } }
  );

  return { ok: true, club, oldLeaderId: leaderId, newLeaderId };
};

const promoteViceLeader = async (
  client,
  { leaderId, guildId, targetId }
) => {
  if (targetId === leaderId)
    return { ok: false, reason: "cannot_promote_self" };

  const leaderM = await service.getMembership(client, leaderId, guildId);
  if (!leaderM) return { ok: false, reason: "not_in_club" };
  if (leaderM.role !== "leader") return { ok: false, reason: "not_leader" };

  const targetM = await service.getMembership(client, targetId, guildId);
  if (!targetM || targetM.guild_club_id !== leaderM.guild_club_id)
    return { ok: false, reason: "target_not_in_your_club" };
  if (targetM.role === "vice_leader")
    return { ok: false, reason: "already_vice_leader" };
  if (targetM.role === "leader")
    return { ok: false, reason: "target_is_leader" };

  const club = await service.getClubById(client, leaderM.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  await client.guildClubMembersCollection.updateOne(
    { userId: targetId, guildId, guild_club_id: club.guild_club_id },
    { $set: { role: "vice_leader" } }
  );

  return { ok: true, club, targetId };
};

const demoteViceLeader = async (
  client,
  { leaderId, guildId, targetId }
) => {
  const leaderM = await service.getMembership(client, leaderId, guildId);
  if (!leaderM) return { ok: false, reason: "not_in_club" };
  if (leaderM.role !== "leader") return { ok: false, reason: "not_leader" };

  const targetM = await service.getMembership(client, targetId, guildId);
  if (!targetM || targetM.guild_club_id !== leaderM.guild_club_id)
    return { ok: false, reason: "target_not_in_your_club" };
  if (targetM.role !== "vice_leader")
    return { ok: false, reason: "target_not_vice_leader" };

  const club = await service.getClubById(client, leaderM.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  await client.guildClubMembersCollection.updateOne(
    { userId: targetId, guildId, guild_club_id: club.guild_club_id },
    { $set: { role: "member" } }
  );

  return { ok: true, club, targetId };
};

module.exports = {
  invite,
  respondInvitation,
  apply,
  listPendingApplications,
  respondApplication,
  leave,
  kick,
  transfer,
  promoteViceLeader,
  demoteViceLeader,
};
