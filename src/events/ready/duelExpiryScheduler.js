require("colors");

const cron = require("node-cron");
const { EmbedBuilder } = require("discord.js");
const duelService = require("../../features/mining/duelService");

// 每分鐘掃逾時未回應的決鬥邀請：退回挑戰者賭注並更新訊息。
let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function sweepOnce(client) {
  if (!client.duelGamesCollection) return;

  const now = new Date();
  const cursor = client.duelGamesCollection.find({
    status: "pending",
    expires_at: { $lte: now },
  });

  while (await cursor.hasNext()) {
    const duel = await cursor.next();
    try {
      const expired = await duelService.expireDuel(client, duel);
      if (!expired) continue;

      if (duel.channel_id && duel.message_id) {
        const channel = await client.channels.fetch(duel.channel_id).catch(() => null);
        if (channel?.isTextBased?.()) {
          const message = await channel.messages
            .fetch(duel.message_id)
            .catch(() => null);
          if (message) {
            const embed = new EmbedBuilder()
              .setColor(0x95a5a6)
              .setTitle("⚔️ 決鬥逾時")
              .setDescription(
                `<@${duel.opponent_id}> 未在時間內回應，` +
                  `<@${duel.challenger_id}> 的賭注已退回。`
              );
            await message.edit({ content: "", embeds: [embed], components: [] }).catch(() => {});
          }
        }
      }
      console.log(`[DUEL] 逾時退款：duel=${duel.duel_id}`.gray);
    } catch (e) {
      console.log(`[ERROR] duel expiry handle ${duel.duel_id}: ${e}`.red);
    }
  }
}

module.exports = async (client) => {
  if (task) return;

  task = cron.schedule("* * * * *", async () => {
    try {
      await sweepOnce(client);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.log(
        `[ERROR] duelExpiryScheduler sweep failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[ERROR] 連續錯誤過多，停止決鬥逾時掃描 cron`.red);
        task.stop();
      }
    }
  });

  console.log(`[DUEL] 決鬥逾時掃描排程已啟動（每分鐘）`.cyan);
};
