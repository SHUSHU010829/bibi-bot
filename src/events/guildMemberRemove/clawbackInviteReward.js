const { inviteSystem } = require("../../config");
const clawbackInviteReward = require("../../features/invite/clawbackInviteReward");

module.exports = async (client, member) => {
  if (!inviteSystem?.enabled) return;
  if (!member?.guild) return;
  if (inviteSystem.ignoreBots && member.user?.bot) return;

  await clawbackInviteReward(client, {
    guild: member.guild,
    inviteeId: member.id,
  });
};
