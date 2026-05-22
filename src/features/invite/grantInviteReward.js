require("colors");
const grantCoins = require("../economy/grantCoins");
const { inviteSystem } = require("../../config");

module.exports = async (client, { guild, inviter, invitee, inviteCode }) => {
  if (!inviteSystem?.enabled) return null;
  if (!client.inviteRecordsCollection) return null;
  if (!guild || !inviter || !invitee) return null;

  const guildId = guild.id;
  const inviterId = inviter.id;
  const inviteeId = invitee.id;

  if (inviterId === inviteeId) return null;

  const existing = await client.inviteRecordsCollection
    .findOne({ guildId, inviteeId })
    .catch(() => null);
  if (existing) {
    console.log(
      `[INVITE] ${inviteeId} 已有邀請紀錄 (status=${existing.status})，不重複發獎`.yellow
    );
    return null;
  }

  const amount = Math.max(0, Math.floor(inviteSystem.rewardAmount || 0));
  if (amount <= 0) return null;

  let inviterMember = null;
  try {
    inviterMember = await guild.members.fetch(inviterId).catch(() => null);
  } catch {
    // ignore
  }

  const granted = await grantCoins(client, {
    userId: inviterId,
    guildId,
    amount,
    source: "invite_reward",
    member: inviterMember,
    username: inviterMember?.user?.username || inviter.username,
    avatarHash: inviterMember?.user?.avatar || inviter.avatar,
    meta: { inviteeId, inviteCode },
  }).catch((e) => {
    console.log(`[INVITE] grantCoins failed: ${e.message}`.red);
    return null;
  });

  await client.inviteRecordsCollection
    .insertOne({
      guildId,
      inviterId,
      inviteeId,
      inviteCode: inviteCode || null,
      joinedAt: new Date(),
      leftAt: null,
      status: "active",
      rewardGranted: granted?.granted || 0,
      clawedBackAt: null,
    })
    .catch((e) => {
      console.log(`[INVITE] insert record failed: ${e.message}`.red);
    });

  console.log(
    `[INVITE] ${inviter.username || inviterId} 邀請 ${invitee.username || inviteeId} 加入，+${granted?.granted || amount}`.green
  );

  return granted;
};
