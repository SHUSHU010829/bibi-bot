require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { finalizeProposal } = require("../../features/voting/finalizeProposal");

async function processExpiredVotes(client) {
  if (!client.votingProposalsCollection) return { finalized: 0 };

  const expiredProposals = await client.votingProposalsCollection
    .find({
      status: "VOTING",
      expiresAt: { $lte: new Date() },
    })
    .toArray();

  if (expiredProposals.length === 0) return { finalized: 0 };

  console.log(
    `[VOTE] 發現 ${expiredProposals.length} 個過期的投票，開始處理...`.yellow,
  );

  let finalized = 0;
  for (const proposal of expiredProposals) {
    try {
      await finalizeProposal(client, proposal, { reason: "expired" });
      finalized += 1;
    } catch (error) {
      console.log(
        `[ERROR] 處理投票 ${proposal.voteId} 時出錯：\n${error}`.red,
      );
    }
  }
  return { finalized };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "vote.expiry",
    label: "投票自動結算",
    schedule: "*/5 * * * *",
    runner: () => processExpiredVotes(client),
  });
};
