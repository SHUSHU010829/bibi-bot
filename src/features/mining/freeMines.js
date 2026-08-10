const { DateTime } = require("luxon");
const twitchPerks = require("./twitchPerks");

const todayKey = () => DateTime.now().setZone("Asia/Taipei").toISODate();

// Twitch 訂閱者的「每日免冷卻挖礦次數」。
// 每日額度依當下的訂閱身分即時算，DB 只存當日已用次數——退訂當天額度立刻歸零，
// 不像發道具那樣留在身上，也無法囤積到活動日一次爆發。
function resolve(profile, member) {
  const limit = twitchPerks.resolvePerks(member)?.dailyFreeMines || 0;
  const date = todayKey();
  const used = profile?.free_mine_used_date === date ? profile.free_mine_used_count || 0 : 0;
  return { limit, used, left: Math.max(0, limit - used), date };
}

// 原子扣一次額度：跨日自動歸零後再 +1。額度已滿或並發搶輸回 false。
async function claim(client, userId, guildId, { limit, date }) {
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      $or: [
        { free_mine_used_date: { $ne: date } },
        { free_mine_used_count: { $lt: limit } },
      ],
    },
    [
      {
        $set: {
          free_mine_used_date: date,
          free_mine_used_count: {
            $cond: [
              { $eq: ["$free_mine_used_date", date] },
              { $add: [{ $ifNull: ["$free_mine_used_count", 0] }, 1] },
              1,
            ],
          },
          updatedAt: "$$NOW",
        },
      },
    ],
  );
  return res.modifiedCount > 0;
}

module.exports = { resolve, claim };
