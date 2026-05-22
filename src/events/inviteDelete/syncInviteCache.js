const { inviteSystem } = require("../../config");
const { removeInvite } = require("../../features/invite/inviteCache");

module.exports = async (client, invite) => {
  if (!inviteSystem?.enabled) return;
  await removeInvite(client, invite);
};
