require("colors");
const { inviteSystem } = require("../../config");
const { primeCache } = require("../../features/invite/inviteCache");

module.exports = async (client, guild) => {
  if (!inviteSystem?.enabled) return;
  if (!guild) return;
  await primeCache(client, guild).catch((e) =>
    console.log(`[INVITE] guildCreate primeCache failed for ${guild.id}: ${e.message}`.red)
  );
};
