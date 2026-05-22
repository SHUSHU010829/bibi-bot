const { DateTime } = require("luxon");
const { inviteSystem } = require("../../config");

const getTodayStart = () => {
  const tz = inviteSystem?.dailyResetTimezone || "Asia/Taipei";
  return DateTime.now().setZone(tz).startOf("day").toJSDate();
};

const countTodayRewardedInvites = async (client, guildId, inviterId) => {
  if (!client.inviteRecordsCollection) return 0;
  return client.inviteRecordsCollection
    .countDocuments({
      guildId,
      inviterId,
      joinedAt: { $gte: getTodayStart() },
      rewardGranted: { $gt: 0 },
    })
    .catch(() => 0);
};

const getDailyCap = () => Math.max(0, Math.floor(inviteSystem?.dailyMaxInvites || 0));

const computeReward = (activeCount) => {
  const base = Math.max(0, Math.floor(inviteSystem?.rewardAmount || 0));
  const step = Math.max(0, Math.floor(inviteSystem?.rewardStep || 0));
  const cap = Math.max(0, Math.floor(inviteSystem?.rewardMax || 0));
  const n = Math.max(0, Math.floor(activeCount || 0));
  const raw = base + step * n;
  return cap > 0 ? Math.min(raw, cap) : raw;
};

const countActiveInvites = async (client, guildId, inviterId) => {
  if (!client.inviteRecordsCollection) return 0;
  return client.inviteRecordsCollection
    .countDocuments({ guildId, inviterId, status: "active" })
    .catch(() => 0);
};

module.exports = {
  computeReward,
  countActiveInvites,
  countTodayRewardedInvites,
  getDailyCap,
};
