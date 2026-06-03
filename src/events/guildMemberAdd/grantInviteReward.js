require("colors");
const { inviteSystem } = require("../../config");
const { findUsedInvite } = require("../../features/invite/inviteCache");
const grantInviteReward = require("../../features/invite/grantInviteReward");
const sendWelcomeNotice = require("../../features/invite/sendWelcome");

module.exports = async (client, member) => {
  if (!member?.guild) return;
  if (member.user?.bot) return;

  let inviter = null;
  let result = null;

  if (inviteSystem?.enabled) {
    const minAgeDays = Math.max(0, Number(inviteSystem.minInviteeAccountAgeDays || 0));
    const ageDays =
      (Date.now() - (member.user?.createdTimestamp || Date.now())) /
      (24 * 60 * 60 * 1000);
    const tooYoung = minAgeDays > 0 && ageDays < minAgeDays;

    if (tooYoung) {
      console.log(
        `[INVITE] ${member.user?.username || member.id} 帳號年齡 ${ageDays.toFixed(1)}d < ${minAgeDays}d，略過獎勵`.yellow
      );
    } else {
      const used = await findUsedInvite(client, member.guild).catch((e) => {
        console.log(`[INVITE] findUsedInvite error: ${e.message}`.red);
        return null;
      });

      if (used && !used.vanity && used.inviterId) {
        let fetchedInviter = used.inviter;
        if (!fetchedInviter) {
          const fetched = await member.guild.members.fetch(used.inviterId).catch(() => null);
          fetchedInviter =
            fetched?.user || (await client.users.fetch(used.inviterId).catch(() => null));
        }
        if (fetchedInviter) {
          inviter = fetchedInviter;
          result = await grantInviteReward(client, {
            guild: member.guild,
            inviter,
            invitee: member.user,
            inviteCode: used.code,
          });
        }
      }
    }
  }

  await sendWelcomeNotice(client, {
    guild: member.guild,
    member,
    invitee: member.user,
    inviter,
    welcomeAmount: result?.welcomeAmount || 0,
    inviterReward: result?.inviterReward || 0,
    activeCount: result?.activeCount || 0,
    cappedByDaily: !!result?.cappedByDaily,
  }).catch((e) =>
    console.log(`[INVITE] welcome notice error: ${e.message}`.red)
  );
};
