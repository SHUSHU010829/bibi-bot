const { inviteSystem } = require("../../config");
const { setInviteUses } = require("../../features/invite/inviteCache");

module.exports = async (client, invite) => {
  if (!inviteSystem?.enabled) return;
  await setInviteUses(client, invite);
};
