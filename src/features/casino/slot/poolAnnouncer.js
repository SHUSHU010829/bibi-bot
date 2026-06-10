// 拉霸 Jackpot Pool 里程碑播報：彩池跨閾值時即時播報。

require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");

const { casino } = require("../../../config");

const MILESTONE_TEMPLATES = [
  {
    threshold: 10000,
    accentColor: 0x3d6f6a,
    build: (pool) =>
      `# 🎰 拉霸 Jackpot 突破 10,000\n` +
      `當前彩池:**${pool.toLocaleString()}** credits\n\n` +
      `想搏一搏?指令:\`/賭場 拉霸\``,
  },
  {
    threshold: 25000,
    accentColor: 0xd94c2a,
    build: (pool) =>
      `# 🎰 拉霸 Jackpot 達 25,000\n` +
      `當前彩池:**${pool.toLocaleString()}** credits\n` +
      `中七七七即可獨得整池!\n\n` +
      `指令:\`/賭場 拉霸\``,
  },
  {
    threshold: 50000,
    accentColor: 0xc9302c,
    build: (pool) =>
      `# 🎰 拉霸 Jackpot 達 50,000\n` +
      `當前彩池:**${pool.toLocaleString()}** credits\n` +
      `中七七七即可獨得整池!\n\n` +
      `指令:\`/賭場 拉霸\``,
  },
  {
    threshold: 100000,
    accentColor: 0xd4a437,
    build: (pool) =>
      `# 🎰 拉霸 Jackpot 突破 100,000!\n` +
      `當前彩池:**${pool.toLocaleString()}** credits\n` +
      `史詩級爆池在即!\n\n` +
      `指令:\`/賭場 拉霸\``,
  },
];

function getCfg() {
  return casino?.slot?.jackpotPool || {};
}

/**
 * 檢查指定 guild 的拉霸 jackpot pool 是否跨過里程碑,跨了就廣播。
 * @param {object} client
 * @param {string} guildId
 */
async function checkAndAnnouncePoolMilestones(client, guildId) {
  if (!client.jackpotPoolCollection) return;

  const cfg = getCfg();
  const milestones = Array.isArray(cfg.poolMilestones) ? cfg.poolMilestones : [];
  if (milestones.length === 0) return;

  const doc = await client.jackpotPoolCollection.findOne({
    guildId,
    game: "slot",
  });
  if (!doc) return;

  const announced = new Set(doc.announcedMilestones || []);
  let toAnnounce = null;
  for (const m of milestones) {
    if ((doc.amount || 0) >= m && !announced.has(m)) {
      toAnnounce = m;
    }
  }
  if (toAnnounce === null) return;

  // atomic claim:race condition 防護
  const result = await client.jackpotPoolCollection.findOneAndUpdate(
    {
      guildId,
      game: "slot",
      announcedMilestones: { $ne: toAnnounce },
    },
    { $addToSet: { announcedMilestones: toAnnounce } },
    { returnDocument: "after" }
  );

  const updated = result?.value || result;
  if (!updated || !updated.announcedMilestones?.includes(toAnnounce)) return;
  if ((doc.announcedMilestones || []).includes(toAnnounce)) return;

  await announcePoolMilestone(client, updated, toAnnounce);
}

async function announcePoolMilestone(client, doc, milestone) {
  const cfg = getCfg();
  const channelId = cfg.announceChannelId;
  if (!channelId) return;

  const channel =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel) {
    console.log(`[SLOT] 找不到 jackpot 播報頻道 ${channelId}`.red);
    return;
  }

  const matched = MILESTONE_TEMPLATES.filter((t) => milestone >= t.threshold);
  const tpl =
    matched.length > 0 ? matched[matched.length - 1] : MILESTONE_TEMPLATES[0];

  const content = tpl.build(doc.amount || 0);

  const container = new ContainerBuilder()
    .setAccentColor(tpl.accentColor)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  try {
    await channel.send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    });
    console.log(
      `[SLOT] 廣播 jackpot 里程碑 ${milestone}(實際彩池 ${doc.amount})`.cyan
    );
  } catch (err) {
    console.log(`[ERROR] 廣播拉霸里程碑失敗:${err}`.red);
  }
}

module.exports = {
  checkAndAnnouncePoolMilestones,
};
