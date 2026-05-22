require("colors");
const { inviteSystem } = require("../../config");
const { primeCache } = require("../../features/invite/inviteCache");

module.exports = async (client) => {
  if (!inviteSystem?.enabled) return;
  for (const guild of client.guilds.cache.values()) {
    await primeCache(client, guild).catch((e) =>
      console.log(`[INVITE] primeCache failed for ${guild.id}: ${e.message}`.red)
    );
  }
};
