const base = require("./welcome.json");

module.exports = {
  welcomeSystem: {
    ...base.welcomeSystem,
    announceChannelId: process.env.WELCOME_ANNOUNCE_CHANNEL_ID,
  },
};
