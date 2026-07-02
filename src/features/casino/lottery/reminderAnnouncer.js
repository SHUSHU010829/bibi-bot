// M8 期中提醒廣播。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { casino } = require("../../../config");
const { getLotteryConfig } = require("./numbers");

// 玩法名 / emoji 共用 numbers.js 的 LOTTERY_CONFIG,避免兩份不同步。
// jackpotRate: 頭獎預估比例(null = 不顯示,固定獎額玩法);buyHint: 購票提示。
const REMINDER_CFG = {
  "6_49": {
    jackpotRate: 0.7,
    buyHint: "`/彩券 購買` ・ `/彩券 包牌` ・ `/彩券 訂閱 開啟`",
  },
  "3_20": {
    jackpotRate: null,
    buyHint: "`/彩券 購買` 玩法選小樂透",
  },
  power_38_8: {
    jackpotRate: 0.6,
    buyHint: "`/彩券 購買` 玩法選威力彩",
  },
};

function buildReminderContent(draw) {
  const numCfg = getLotteryConfig(draw.lotteryType);
  const cfg = REMINDER_CFG[draw.lotteryType];
  if (!numCfg || !cfg) return null;

  const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
  const poolFmt = (draw.pool || 0).toLocaleString();

  const lines = [
    `# ${numCfg.emoji} ${numCfg.label} 第 ${draw.drawNumber} 期 進度更新`,
    `當前彩池:**${poolFmt}** credits`,
  ];
  if (cfg.jackpotRate) {
    lines.push(
      `頭獎預估:約 ${Math.floor((draw.pool || 0) * cfg.jackpotRate).toLocaleString()} credits`
    );
  }
  lines.push(`已售出:${draw.totalTickets || 0} 張票`);
  lines.push(`開獎倒數:<t:${drawAtUnix}:R>`);
  lines.push("");
  lines.push(`購票指令:${cfg.buyHint}`);

  return { content: lines.join("\n"), accentColor: 0x3d6f6a };
}

async function announceReminder(client, draw) {
  const cfg = casino?.lottery || {};
  const channelId = cfg.poolMilestoneChannelId || cfg.announceChannelId;
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  const built = buildReminderContent(draw);
  if (!built) return;

  const { content, accentColor } = built;
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
