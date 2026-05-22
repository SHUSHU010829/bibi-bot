require("colors");
const { inviteSystem } = require("../../config");
const { findUsedInvite } = require("../../features/invite/inviteCache");
const grantInviteReward = require("../../features/invite/grantInviteReward");

module.exports = async (client, member) => {
  if (!inviteSystem?.enabled) return;
  if (!member?.guild) return;

  if (inviteSystem.ignoreBots && member.user?.bot) return;

  const minAgeDays = Math.max(0, Number(inviteSystem.minInviteeAccountAgeDays || 0));
  if (minAgeDays > 0) {
    const ageDays =
      (Date.now() - (member.user?.createdTimestamp || Date.now())) /
      (24 * 60 * 60 * 1000);
    if (ageDays < minAgeDays) {
      console.log(
        `[INVITE] ${member.user?.username || member.id} 帳號年齡 ${ageDays.toFixed(1)}d < ${minAgeDays}d，略過獎勵`.yellow
      );
      return;
    }
  }

  const used = await findUsedInvite(client, member.guild).catch((e) => {
    console.log(`[INVITE] findUsedInvite error: ${e.message}`.red);
    return null;
  });

  if (!used) return;
  if (used.vanity) return;
  if (!used.inviterId) return;

  let inviter = used.inviter;
  if (!inviter) {
    try {
      const fetched = await member.guild.members.fetch(used.inviterId).catch(() => null);
      inviter = fetched?.user || (await client.users.fetch(used.inviterId).catch(() => null));
    } catch {
      // ignore
    }
  }
  if (!inviter) return;

  await grantInviteReward(client, {
    guild: member.guild,
    inviter,
    invitee: member.user,
    inviteCode: used.code,
  });
};
