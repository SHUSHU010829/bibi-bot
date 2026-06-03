require("colors");
const { MessageFlags } = require("discord.js");
const { boss, guildClub } = require("../../config");
const guildClubView = require("./guildClubView");

async function resolveAnnounceChannel(client) {
  const override = guildClub?.announce?.channelIdOverride;
  if (override) {
    const ch = await client.channels.fetch(override).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  if (guildClub?.announce?.useBossChannel && boss?.announceChannelId) {
    const ch = await client.channels.fetch(boss.announceChannelId).catch(() => null);
    if (ch?.isTextBased?.()) return ch;
  }
  return null;
}

async function announceLevelUp(client, levelUp) {
  const ch = await resolveAnnounceChannel(client);
  if (!ch) return;
  const container = guildClubView.buildLevelUpAnnouncementContainer(levelUp);
  await ch
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch((e) =>
      console.log(`[GUILD_CLUB] announceLevelUp 失敗：${e.message}`.yellow)
    );
}

module.exports = {
  resolveAnnounceChannel,
  announceLevelUp,
};
