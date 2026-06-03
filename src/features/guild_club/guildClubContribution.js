require("colors");
const { DateTime } = require("luxon");
const { guildClub } = require("../../config");

const tz = () => guildClub?.resetTimezone || "Asia/Taipei";

const currentWeekKey = () =>
  DateTime.now().setZone(tz()).toFormat("kkkk-'W'WW");

// 累加單筆貢獻；跨週時自動把 weekly 歸零後再加。
async function addContribution(client, { userId, guildId, guildClubId, amount }) {
  if (!client?.guildClubContributionsCollection) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const weekKey = currentWeekKey();
  const now = new Date();

  const existing = await client.guildClubContributionsCollection
    .findOne({ userId, guildId })
    .catch(() => null);

  if (!existing) {
    const doc = {
      userId,
      guildId,
      guild_club_id: guildClubId,
      totalContribution: amount,
      weeklyContribution: amount,
      weekKey,
      lastBossAt: now,
      updatedAt: now,
    };
    await client.guildClubContributionsCollection.insertOne(doc).catch(() => null);
    return doc;
  }

  const sameWeek = existing.weekKey === weekKey;
  const sameClub = existing.guild_club_id === guildClubId;
  const update = {
    $set: {
      guild_club_id: guildClubId,
      weekKey,
      lastBossAt: now,
      updatedAt: now,
      weeklyContribution: sameWeek && sameClub
        ? (existing.weeklyContribution || 0) + amount
        : amount,
    },
    $inc: { totalContribution: amount },
  };
  await client.guildClubContributionsCollection
    .updateOne({ userId, guildId }, update)
    .catch(() => null);
  return null;
}

// 本週公會內 BOSS 貢獻 Top N（只算本週 weekKey 的紀錄）。
async function getWeeklyTop(client, guildClubId, limit = 5) {
  if (!client?.guildClubContributionsCollection) return [];
  const weekKey = currentWeekKey();
  return client.guildClubContributionsCollection
    .find({ guild_club_id: guildClubId, weekKey })
    .sort({ weeklyContribution: -1 })
    .limit(limit)
    .toArray()
    .catch(() => []);
}

module.exports = {
  currentWeekKey,
  addContribution,
  getWeeklyTop,
};
