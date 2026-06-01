require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const duelService = require("../../features/mining/duelService");

// 每分鐘掃逾時未回應的決鬥邀請：退回挑戰者賭注並更新訊息。

async function sweepOnce(client) {
  if (!client.duelGamesCollection) return { expired: 0 };

  const now = new Date();
  const cursor = client.duelGamesCollection.find({
    status: "pending",
    expires_at: { $lte: now },
  });

  let expired = 0;
  while (await cursor.hasNext()) {
    const duel = await cursor.next();
    try {
      const didExpire = await duelService.expireDuel(client, duel);
      if (!didExpire) continue;

      if (duel.channel_id && duel.message_id) {
        const channel = await client.channels.fetch(duel.channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const message = await channel.messages
            .fetch(duel.message_id)
            .catch(() => null);
          if (message) {
            const container = new ContainerBuilder()
              .setAccentColor(0x95a5a6)
              .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                  `# ⚔️ 決鬥逾時\n` +
                    `<@${duel.opponent_id}> 未在時間內回應，` +
                    `<@${duel.challenger_id}> 的賭注已退回。`,
                ),
              );
            await message
              .edit({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
              })
              .catch(() => {});
          }
        }
      }
      expired += 1;
      console.log(`[DUEL] 逾時退款：duel=${duel.duel_id}`.gray);
    } catch (e) {
      console.log(`[ERROR] duel expiry handle ${duel.duel_id}: ${e}`.red);
    }
  }
  return { expired };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "duel.expiry",
    label: "決鬥逾時退款",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
};
