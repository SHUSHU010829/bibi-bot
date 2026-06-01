const base = require("./donation.json");

module.exports = {
  donation: {
    ...base.donation,
    announceChannelId: process.env.DONATION_ANNOUNCE_CHANNEL_ID,
    roleIds: {
      donor: process.env.DONATION_DONOR_ROLE_ID,
      vipDonor: process.env.DONATION_VIP_DONOR_ROLE_ID,
    },
  },
};
