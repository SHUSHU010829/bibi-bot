// M7 里程碑播報:事件觸發,彩池跨閾值時即時播報。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { casino } = require("../../../config");
const { getLotteryConfig } = require("./numbers");

// 每個玩法的播報配置：頭獎預估比例 + 購票提示。
// emoji / 玩法名共用 numbers.js 的 LOTTERY_CONFIG，避免兩份不同步。
const ANNOUNCE_CFG = {
  "6_49": {
    jackpotRate: 0.7,
    buyHint: "`/彩券 購買` ・ `/彩券 包牌`",
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

// 顏色階梯，低 → 高：teal → 橘 → 紅 → 金。
const ACCENT_TIERS = [0x3d6f6a, 0xd94c2a, 0xc9302c, 0xd4a437];

function pickAccentColor(lotteryType, milestone) {
  const list = casino?.lottery?.poolMilestones?.[lotteryType] || [];
  const idx = list.indexOf(milestone);
  if (idx < 0 || list.length <= 1) return ACCENT_TIERS[0];
  const position = idx / (list.length - 1);
  const tier = Math.min(
    ACCENT_TIERS.length - 1,
    Math.floor(position * ACCENT_TIERS.length)
  );
  return ACCENT_TIERS[tier];
}

function buildMilestoneContent(lotteryType, milestone, pool, drawAtUnix) {
  const numCfg = getLotteryConfig(lotteryType);
  const ann = ANNOUNCE_CFG[lotteryType];
  if (!numCfg || !ann) return null;
  const lines = [
    `# ${numCfg.emoji} ${numCfg.label}彩池突破 ${milestone.toLocaleString()}`,
    `當前彩池:**${pool.toLocaleString()}** credits`,
  ];
  if (ann.jackpotRate) {
    lines.push(
      `頭獎預估:約 ${Math.floor(pool * ann.jackpotRate).toLocaleString()} credits`
    );
  }
  lines.push(`開獎時間:<t:${drawAtUnix}:R>`);
  lines.push("");
  lines.push(`購票指令:${ann.buyHint}`);
  return lines.join("\n");
}

/**
 * 檢查彩池有沒有跨過里程碑,跨了就廣播。
 * @param {object} client
 * @param {ObjectId} drawObjectId 樂透期 _id(不是 drawId)
 */
async function checkAndAnnouncePoolMilestones(client, drawObjectId) {
  if (!client.lotteryDrawsCollection) return;

  const draw = await client.lotteryDrawsCollection.findOne({ _id: drawObjectId });
  if (!draw || draw.status !== "open") return;

  const milestones = casino?.lottery?.poolMilestones?.[draw.lotteryType] || [];
  if (milestones.length === 0) return;

  const announced = new Set(draw.announcedMilestones || []);
  // 單筆大量購票可能一次跨過好幾個里程碑：只播報最高的那個，
  // 但被跳過的也要一併記成已播報，否則之後每次購票都會補播一則過期的低里程碑。
  const crossed = milestones.filter((m) => draw.pool >= m && !announced.has(m));
  if (crossed.length === 0) return;
  const toAnnounce = crossed[crossed.length - 1];

  // atomic claim:race condition 防護
  const result = await client.lotteryDrawsCollection.findOneAndUpdate(
    {
      _id: drawObjectId,
      announcedMilestones: { $ne: toAnnounce },
    },
    { $addToSet: { announcedMilestones: { $each: crossed } } },
    { returnDocument: "after" }
  );

  const updated = result?.value || result;
  if (!updated || !updated.announcedMilestones?.includes(toAnnounce)) return;

  // 確認自己是這次 update 的得標者(announcedMilestones 從不含 → 含)
  if ((draw.announcedMilestones || []).includes(toAnnounce)) return;

  await announcePoolMilestone(client, updated, toAnnounce);
}

async function announcePoolMilestone(client, draw, milestone) {
  const cfg = casino?.lottery || {};
  const channelId = cfg.poolMilestoneChannelId || cfg.announceChannelId;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.log(`[LOTTERY] 找不到播報頻道 ${channelId}`.red);
    return;
  }

  const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
  const content = buildMilestoneContent(
    draw.lotteryType,
    milestone,
    draw.pool,
    drawAtUnix
  );
  if (!content) return;

  const container = new ContainerBuilder()
    .setAccentColor(pickAccentColor(draw.lotteryType, milestone))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  try {
    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    console.log(
      `[LOTTERY] 廣播里程碑 ${draw.lotteryType} ${milestone}(實際彩池 ${draw.pool})`.cyan
    );
  } catch (err) {
    console.log(`[ERROR] 廣播里程碑失敗:${err}`.red);
  }
}

module.exports = {
  checkAndAnnouncePoolMilestones,
};
