require("colors");
const grantCoins = require("../economy/grantCoins");
const { inviteSystem } = require("../../config");
const {
  computeReward,
  countActiveInvites,
  countTodayRewardedInvites,
  getDailyCap,
} = require("./rewardFormula");

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

  const activeCount = await countActiveInvites(client, guildId, inviterId);
  const baseAmount = computeReward(activeCount);

  const dailyCap = getDailyCap();
  let cappedByDaily = false;
  if (dailyCap > 0) {
    const todayCount = await countTodayRewardedInvites(client, guildId, inviterId);
    if (todayCount >= dailyCap) {
      cappedByDaily = true;
    }
  }

  const amount = cappedByDaily ? 0 : baseAmount;

  let inviterMember = null;
  try {
    inviterMember = await guild.members.fetch(inviterId).catch(() => null);
  } catch {
    // ignore
  }

  let granted = null;
  if (amount > 0) {
    granted = await grantCoins(client, {
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
  }

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
      activeCountBefore: activeCount,
      cappedByDaily,
      clawedBackAt: null,
    })
    .catch((e) => {
      console.log(`[INVITE] insert record failed: ${e.message}`.red);
    });

  if (cappedByDaily) {
    console.log(
      `[INVITE] ${inviter.username || inviterId} 邀請 ${invitee.username || inviteeId}（第 ${activeCount + 1} 人）今日已達上限 ${dailyCap}，不發獎`.yellow
    );
  } else {
    console.log(
      `[INVITE] ${inviter.username || inviterId} 邀請 ${invitee.username || inviteeId} 加入（第 ${activeCount + 1} 人）+${granted?.granted || amount}`.green
    );
  }

  let welcomeGranted = 0;
  const welcomeAmount = Math.max(0, Math.floor(inviteSystem.inviteeWelcomeBonus || 0));
  if (welcomeAmount > 0) {
    const inviteeMember = guild.members?.cache?.get(inviteeId) || null;
    const w = await grantCoins(client, {
      userId: inviteeId,
      guildId,
      amount: welcomeAmount,
      source: "invite_welcome",
      member: inviteeMember,
      username: inviteeMember?.user?.username || invitee.username,
      avatarHash: inviteeMember?.user?.avatar || invitee.avatar,
      meta: { inviterId, inviteCode },
    }).catch((e) => {
      console.log(`[INVITE] invitee welcome grantCoins failed: ${e.message}`.yellow);
      return null;
    });
    welcomeGranted = w?.granted || 0;
    console.log(
      `[INVITE] 被邀請者 ${invitee.username || inviteeId} 獲得歡迎金 +${welcomeGranted}`.cyan
    );
  }

  return {
    inviterReward: granted?.granted || 0,
    activeCount,
    cappedByDaily,
    welcomeAmount: welcomeGranted,
  };
};
