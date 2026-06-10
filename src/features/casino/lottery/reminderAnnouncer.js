// M8 期中提醒廣播。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { casino } = require("../../../config");

const REMINDER_TEMPLATES = {
  "6_49": (draw) => {
    const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
    const ticketCount = draw.totalTickets || 0;
    const poolFmt = (draw.pool || 0).toLocaleString();
    const jackpotEst = Math.floor((draw.pool || 0) * 0.7).toLocaleString();
    return {
      content:
        `# 🎰 大樂透 第 ${draw.drawNumber} 期 進度更新\n` +
        `當前彩池:**${poolFmt}** credits\n` +
        `頭獎預估:約 ${jackpotEst} credits\n` +
        `已售出:${ticketCount} 張票\n` +
        `開獎倒數:<t:${drawAtUnix}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` ・ \`/賭場 樂透 包牌\` ・ \`/賭場 樂透 訂閱開啟\``,
      accentColor: 0x3d6f6a,
    };
  },
  "3_20": (draw) => {
    const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
    const ticketCount = draw.totalTickets || 0;
    const poolFmt = (draw.pool || 0).toLocaleString();
    return {
      content:
        `# 🎫 小樂透 第 ${draw.drawNumber} 期 進度更新\n` +
        `當前彩池:**${poolFmt}** credits\n` +
        `已售出:${ticketCount} 張票\n` +
        `開獎倒數:<t:${drawAtUnix}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` 玩法選小樂透`,
      accentColor: 0x3d6f6a,
    };
  },
};

async function announceReminder(client, draw) {
  const cfg = casino?.lottery || {};
  const channelId = cfg.poolMilestoneChannelId || cfg.announceChannelId;
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const builder = REMINDER_TEMPLATES[draw.lotteryType];
  if (!builder) return;

  const { content, accentColor } = builder(draw);
  const container = new ContainerBuilder()
    .setAccentColor(accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  try {
    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    console.log(
      `[LOTTERY] 期中提醒已播 ${draw.drawId}(彩池 ${draw.pool}, 票數 ${draw.totalTickets})`.cyan
    );
  } catch (err) {
    console.log(`[ERROR] 期中提醒廣播失敗:${err}`.red);
  }
}

/**
 * 掃所有 open 期,把該觸發的 reminder 觸發掉。
 */
async function processReminders(client) {
  if (!client.lotteryDrawsCollection) return;
  const now = new Date();

  const draws = await client.lotteryDrawsCollection
    .find({
      status: "open",
      scheduledReminders: {
        $elemMatch: { fireAt: { $lte: now }, fired: false },
      },
    })
    .toArray();

  for (const draw of draws) {
    const reminders = draw.scheduledReminders || [];
    for (let i = 0; i < reminders.length; i++) {
      const r = reminders[i];
      if (!r || r.fired) continue;
      if (new Date(r.fireAt) > now) continue;

      const result = await client.lotteryDrawsCollection.findOneAndUpdate(
        {
          _id: draw._id,
          [`scheduledReminders.${i}.fired`]: false,
        },
        {
          $set: {
            [`scheduledReminders.${i}.fired`]: true,
            [`scheduledReminders.${i}.firedAt`]: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      const updated = result?.value || result;
      if (!updated) continue;

      // 重新讀最新彩池(中間幾分鐘可能有人買票)
      const latestDraw = await client.lotteryDrawsCollection.findOne({
        _id: draw._id,
      });
      if (!latestDraw || latestDraw.status !== "open") continue;
      await announceReminder(client, latestDraw);
    }
  }
}

module.exports = {
  announceReminder,
  processReminders,
};
