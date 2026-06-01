const base = require("./twitch.json");

module.exports = {
  twitch: {
    ...base.twitch,
    channelId: process.env.DISCORD_TWITCH_CHANNEL_ID,
    mentionRoleId: process.env.TWITCH_MENTION_ROLE_ID,
  },
};
