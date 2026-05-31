require("colors");

const cron = require("node-cron");

const { normalChannelId, morningMessage } = require("../../config");
const buildMorningPayload = require("../../utils/buildMorningPayload");

module.exports = (client) => {
  cron.schedule(
    morningMessage.cronSchedule,
    async () => {
      const channel = client.channels.cache.get(normalChannelId);

      if (!channel) {
        console.log(`[ERROR] 早安訊息：無法找到目標頻道`.red);
        return;
      }

      try {
        const { attachment } = await buildMorningPayload({
          timezone: morningMessage.timezone,
          client,
        });

        await channel.send({
          content: `早安！${morningMessage.emojis.yaa}`,
          files: [attachment],
        });
      } catch (error) {
        console.log(`[ERROR] 早安訊息發送失敗：\n${error}`.red);
      }
    },
    {
      scheduled: true,
      timezone: morningMessage.timezone,
    }
  );
};
