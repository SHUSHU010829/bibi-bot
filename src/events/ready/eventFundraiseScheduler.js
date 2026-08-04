require("colors");
const { registerCron } = require("../../utils/cronRegistry");
const { refreshEventMessage } = require("../../features/event/hostedEvent");

// 募資到期只是「不再收贊助」，不會自動結束活動（要不要開報名、要不要退款是主辦人的決定）。
// 這支排程只負責把過期的募資卡片刷成截止樣式，並提醒主辦人一次。
async function sweepOnce(client) {
  if (!client.hostedEventsCollection) return { expired: 0 };

  const expired = await client.hostedEventsCollection
    .find({
      status: "FUNDRAISING",
      "funding.deadline": { $lte: new Date() },
      "funding.deadlineNotified": { $ne: true },
    })
    .toArray();

  for (const doc of expired) {
    await client.hostedEventsCollection.updateOne(
      { _id: doc._id },
      { $set: { "funding.deadlineNotified": true, updatedAt: new Date() } },
    );
    await refreshEventMessage(client, doc).catch(() => {});

    const host = await client.users.fetch(doc.hostId).catch(() => null);
    if (host) {
      const raised = (doc.funding?.raised || 0).toLocaleString();
      await host
        .send({
          content:
            `⏰ 你的募資活動「${doc.name}」募資期限已到，共募得 **${raised}** credits。\n` +
            "到活動訊息按「⚙️ 管理」→「🚀 結束募資，開始報名」開跑，或「🚫 取消活動並全額退還」把贊助原路退回。",
        })
        .catch(() => {});
    }
  }

  if (expired.length) {
    console.log(`[FUNDRAISE] 募資到期提醒 ${expired.length} 筆`.gray);
  }
  return { expired: expired.length };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "eventFundraise.deadline",
    label: "活動募資到期提醒",
    schedule: "*/10 * * * *",
    runner: () => sweepOnce(client),
  });
};
