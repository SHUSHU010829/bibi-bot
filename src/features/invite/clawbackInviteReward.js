require("colors");
const grantCoins = require("../economy/grantCoins");
const { inviteSystem } = require("../../config");

module.exports = async (client, { guild, inviteeId }) => {
  if (!inviteSystem?.enabled) return null;
  if (!client.inviteRecordsCollection) return null;
  if (!guild || !inviteeId) return null;

  const guildId = guild.id;
  const record = await client.inviteRecordsCollection
    .findOne({ guildId, inviteeId })
    .catch(() => null);

  if (!record) return null;
  if (record.status !== "active") return null;

  const clawbackDays = Math.max(0, Number(inviteSystem.clawbackDays || 0));
  const joinedAt = record.joinedAt ? new Date(record.joinedAt).getTime() : 0;
  const elapsedDays = (Date.now() - joinedAt) / (24 * 60 * 60 * 1000);

  if (clawbackDays > 0 && elapsedDays > clawbackDays) {
    await client.inviteRecordsCollection
      .updateOne(
        { _id: record._id },
        { $set: { status: "left", leftAt: new Date() } }
      )
      .catch(() => {});
    return null;
  }

  const amount = Math.max(0, Math.floor(record.rewardGranted || 0));
  let clawback = null;
  if (amount > 0) {
    let inviterMember = null;
    try {
      inviterMember = await guild.members.fetch(record.inviterId).catch(() => null);
    } catch {
      // ignore
    }

    clawback = await grantCoins(client, {
      userId: record.inviterId,
      guildId,
      amount: -amount,
      source: "invite_clawback",
      member: inviterMember,
      username: inviterMember?.user?.username,
      meta: { inviteeId, inviteCode: record.inviteCode || null },
    }).catch((e) => {
      console.log(`[INVITE] clawback grantCoins failed: ${e.message}`.red);
      return null;
    });
  }

  await client.inviteRecordsCollection
    .updateOne(
      { _id: record._id },
      {
        $set: {
          status: "clawed_back",
          leftAt: new Date(),
          clawedBackAt: new Date(),
          clawedBackAmount: amount,
        },
      }
    )
    .catch(() => {});

  console.log(
    `[INVITE] clawback inviter=${record.inviterId} invitee=${inviteeId} -${amount}`.yellow
  );

  return clawback;
};
