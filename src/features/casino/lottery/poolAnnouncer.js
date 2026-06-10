// M7 里程碑播報:事件觸發,彩池跨閾值時即時播報。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { casino } = require("../../../config");

const MILESTONE_TEMPLATES = {
  "6_49": [
    {
      threshold: 10000,
      build: (pool, drawAt) =>
        `# 🎰 大樂透彩池突破 10,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\``,
      accentColor: 0x3d6f6a,
    },
    {
      threshold: 30000,
      build: (pool, drawAt) =>
        `# 🎰 大樂透彩池達 30,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `頭獎預估:約 ${Math.floor(pool * 0.7).toLocaleString()} credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` ・ \`/賭場 樂透 包牌\``,
      accentColor: 0xd94c2a,
    },
    {
      threshold: 50000,
      build: (pool, drawAt) =>
        `# 🎰 大樂透彩池達 50,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `頭獎預估:約 ${Math.floor(pool * 0.7).toLocaleString()} credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` ・ \`/賭場 樂透 包牌\``,
      accentColor: 0xc9302c,
    },
    {
      threshold: 100000,
      build: (pool, drawAt) =>
        `# 🎰 大樂透彩池突破 100,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `頭獎預估:約 ${Math.floor(pool * 0.7).toLocaleString()} credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` ・ \`/賭場 樂透 包牌\``,
      accentColor: 0xd4a437,
    },
  ],
  "3_20": [
    {
      threshold: 1000,
      build: (pool, drawAt) =>
        `# 🎫 小樂透彩池突破 1,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` 玩法選小樂透`,
      accentColor: 0x3d6f6a,
    },
    {
      threshold: 5000,
      build: (pool, drawAt) =>
        `# 🎫 小樂透彩池達 5,000\n` +
        `當前彩池:**${pool.toLocaleString()}** credits\n` +
        `開獎時間:<t:${drawAt}:R>\n\n` +
        `購票指令:\`/賭場 樂透 買\` 玩法選小樂透`,
      accentColor: 0xd94c2a,
    },
  ],
};

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
  let toAnnounce = null;
  for (const m of milestones) {
    if (draw.pool >= m && !announced.has(m)) {
      toAnnounce = m;
    }
  }
  if (toAnnounce === null) return;

  // atomic claim:race condition 防護
  const result = await client.lotteryDrawsCollection.findOneAndUpdate(
    {
      _id: drawObjectId,
      announcedMilestones: { $ne: toAnnounce },
    },
    { $addToSet: { announcedMilestones: toAnnounce } },
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

  const templates = MILESTONE_TEMPLATES[draw.lotteryType] || [];
  if (templates.length === 0) return;

  const matched = templates.filter((t) => milestone >= t.threshold);
  const tpl = matched.length > 0 ? matched[matched.length - 1] : templates[0];

  const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
  const content = tpl.build(draw.pool, drawAtUnix);

  const container = new ContainerBuilder()
    .setAccentColor(tpl.accentColor)
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
