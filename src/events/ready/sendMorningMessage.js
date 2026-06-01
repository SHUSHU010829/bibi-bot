require("colors");

const { registerCron } = require("../../utils/cronRegistry");

const { normalChannelId, morningMessage } = require("../../config");
const buildMorningPayload = require("../../utils/buildMorningPayload");

async function sendMorning(client) {
  const channel = client.channels.cache.get(normalChannelId);

  if (!channel) {
    console.log(`[ERROR] 早安訊息：無法找到目標頻道`.red);
    return { sent: false, reason: "channel_not_found" };
  }

  const { attachment } = await buildMorningPayload({
    timezone: morningMessage.timezone,
    client,
  });

  await channel.send({
    content: `早安！${morningMessage.emojis.yaa}`,
    files: [attachment],
  });
  return { sent: true };
}

module.exports = (client) => {
  registerCron(client, {
    name: "morningMessage.send",
    label: "每日早安訊息",
    schedule: morningMessage.cronSchedule,
    timezone: morningMessage.timezone,
    runner: () => sendMorning(client),
  });
};
