const { DateTime } = require("luxon");
const twitchPerks = require("./twitchPerks");

// Twitch 訂閱者的「每日免冷卻次數」（挖礦 / 釣魚共用同一套邏輯，額度各自獨立）。
// 每日額度依當下的訂閱身分即時算，DB 只存當日已用次數——退訂當天額度立刻歸零，
// 不像發道具那樣留在身上，也無法囤積到活動日一次爆發。
const KINDS = {
  mine: {
    perkKey: "dailyFreeMines",
    dateField: "free_mine_used_date",
    countField: "free_mine_used_count",
  },
  fish: {
    perkKey: "dailyFreeFishes",
    dateField: "free_fish_used_date",
    countField: "free_fish_used_count",
  },
};

const todayKey = () => DateTime.now().setZone("Asia/Taipei").toISODate();

function resolve(kind, profile, member) {
  const k = KINDS[kind];
  const limit = twitchPerks.resolvePerks(member)?.[k.perkKey] || 0;
  const date = todayKey();
  const used = profile?.[k.dateField] === date ? profile[k.countField] || 0 : 0;
  return { kind, limit, used, left: Math.max(0, limit - used), date };
}

// 原子扣一次額度：跨日自動歸零後再 +1。額度已滿或並發搶輸回 false。
async function claim(client, userId, guildId, { kind, limit, date }) {
  const { dateField, countField } = KINDS[kind];
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      $or: [{ [dateField]: { $ne: date } }, { [countField]: { $lt: limit } }],
    },
    [
      {
        $set: {
          [dateField]: date,
          [countField]: {
            $cond: [
              { $eq: [`$${dateField}`, date] },
              { $add: [{ $ifNull: [`$${countField}`, 0] }, 1] },
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
