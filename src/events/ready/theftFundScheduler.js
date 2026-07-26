require("colors");

const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const { registerCron } = require("../../utils/cronRegistry");
const { theft } = require("../../config");
const theftService = require("../../features/theft/theftService");
const theftBoard = require("../../features/theft/theftBoard");

// 每週結算治安基金：發給本週逮捕人數最多的獵人，並在通緝廣播頻道公告。
async function payoutOnce(client) {
  const chId = theft?.announceChannelId;
  if (!theft?.fund?.enabled || !chId) return { paid: false };
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch?.isTextBased?.()) return { paid: false };
  const guildId = ch.guildId || ch.guild?.id;
  if (!guildId) return { paid: false };

  const res = await theftService.payoutWeeklyFund(client, guildId);
  if (res?.paid) {
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const rankLines = res.winners
      .map(
        (w) =>
          `${medals[w.rank - 1] || `${w.rank}.`} <@${w.userId}> — 逮捕 **${w.hunts}** 名、賞金收入 **${w.earned.toLocaleString()}** 🪙\n` +
          `　　　　瓜分治安基金 **+${w.amount.toLocaleString()}** 🪙`
      )
      .join("\n");
    const container = new ContainerBuilder()
      .setAccentColor(0xf1c40f)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 🏆 本週賞金獵人榜！\n` +
            `本週前 ${res.winners.length} 名獵人依名次瓜分整池**治安基金 ${res.pool.toLocaleString()}** 🪙：\n\n` +
            rankLines
        )
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("-# 治安基金由被逮贖罪金與自首保釋金累積 · 下週再戰")
      );
    await ch.send({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(() => {});
    console.log(
      `[THEFT] 治安基金週結算：pool=${res.pool} winners=${res.winners.map((w) => `${w.userId}(+${w.amount})`).join(",")}`.cyan
    );
  }
  await theftBoard.refresh(client);
  return res || { paid: false };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "theft.fund.weekly",
    label: "治安基金週結算",
    schedule: theft?.fund?.payoutCron || "0 21 * * 0",
    runner: () => payoutOnce(client),
  });
};
