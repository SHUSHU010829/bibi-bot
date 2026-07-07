// 個人賭場統計：總下注、總派彩、RTP、各遊戲分項
require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");
const { DateTime } = require("luxon");
const { gameLabel } = require("../../casino/gameLabels");

function getDateFilter(period) {
  const now = DateTime.now().setZone("Asia/Taipei");
  switch (period) {
    case "today":
      return { date: now.toISODate() };
    case "week":
      return { date: { $gte: now.startOf("week").toISODate() } };
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "all":
    default:
      return {};
  }
}

function describePeriod(period) {
  switch (period) {
    case "today":
      return "今天";
    case "week":
      return "本週";
    case "month":
      return "本月";
    case "all":
    default:
      return "全部時間";
  }
}

async function buildCasinoStatsView(client, { target, member, guildId, period }) {
  if (!client.coinTransactionsCollection) {
    return { content: "🔧 金幣系統尚未啟動。" };
  }

  const effPeriod = period || "all";
  const userId = target.id;
  const dateFilter = getDateFilter(effPeriod);

  const rows = await client.coinTransactionsCollection
    .aggregate([
      {
        $match: {
          userId,
          guildId,
          source: { $in: ["bet", "payout"] },
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: { game: "$meta.game", source: "$source" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ])
    .toArray();

  if (!rows.length) {
    return {
      content: `📊 你在這個期間（${describePeriod(effPeriod)}）還沒有任何賭場紀錄。`,
    };
  }

  const perGame = {};
  // 紅包屬社交送禮，單獨顯示、不計入賭場統計總計與各遊戲分項
  const redPacket = { wagered: 0, payout: 0, betCount: 0 };
  let totalWagered = 0;
  let totalPayout = 0;
  let totalBetCount = 0;

  for (const r of rows) {
    const game = r._id.game || "unknown";
    const src = r._id.source;
    const isRedPacket = game === "redPacket";
    const bucket = isRedPacket
      ? redPacket
      : (perGame[game] ||= { wagered: 0, payout: 0, betCount: 0 });
    if (src === "bet") {
      bucket.wagered += Math.abs(r.total);
      bucket.betCount += r.count;
      if (!isRedPacket) {
        totalWagered += Math.abs(r.total);
        totalBetCount += r.count;
      }
    } else if (src === "payout") {
      bucket.payout += r.total;
      if (!isRedPacket) totalPayout += r.total;
    }
  }

  const netProfit = totalPayout - totalWagered;
  const overallRtp = totalWagered > 0 ? (totalPayout / totalWagered) * 100 : 0;
  const username = member?.displayName || target.username;

  const games = Object.entries(perGame).sort(
    (a, b) => b[1].wagered - a[1].wagered
  );
  const hasGamble = games.length > 0;
  const hasRedPacket = redPacket.betCount > 0 || redPacket.payout > 0;

  const overall = hasGamble
    ? `**${username}** 的賭場紀錄 ・ ${describePeriod(effPeriod)}\n\n` +
      `💸 總下注：**${totalWagered.toLocaleString()}** credits（共 ${totalBetCount.toLocaleString()} 注）\n` +
      `${MONEY_EMOJI} 總派彩：**${totalPayout.toLocaleString()}** credits\n` +
      `${netProfit >= 0 ? "📈" : "📉"} 淨輸贏：**${netProfit >= 0 ? "+" : ""}${netProfit.toLocaleString()}**\n` +
      `🎯 RTP（回收率）：**${overallRtp.toFixed(1)}%**${overallRtp < 100 ? "（賠錢中）" : "（賺錢中）"}`
    : `**${username}** 的賭場紀錄 ・ ${describePeriod(effPeriod)}\n\n` +
      `-# 這個期間沒有賭場遊戲紀錄。`;

  const perGameLines = games.map(([game, s]) => {
    const label = gameLabel(game);
    const net = s.payout - s.wagered;
    const rtp = s.wagered > 0 ? (s.payout / s.wagered) * 100 : 0;
    return (
      `${label}\n` +
      `-# 下注 ${s.wagered.toLocaleString()}（${s.betCount} 注）・ 派彩 ${s.payout.toLocaleString()}\n` +
      `-# 淨 ${net >= 0 ? "+" : ""}${net.toLocaleString()}　・　RTP ${rtp.toFixed(1)}%`
    );
  });

  const redPacketText = hasRedPacket
    ? `${gameLabel("redPacket")} ・ 不計入上方統計\n` +
      `-# 發出 ${redPacket.wagered.toLocaleString()}（${redPacket.betCount} 個）・ 領取 ${redPacket.payout.toLocaleString()}`
    : null;

  const accent = !hasGamble ? 0x95a5a6 : netProfit >= 0 ? 0x2ecc71 : 0xe74c3c;

  const container = new ContainerBuilder()
    .setAccentColor(accent)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# 📊 你的賭場紀錄")
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(overall));

  if (hasGamble) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(perGameLines.join("\n\n"))
      );
  }

  if (redPacketText) {
    container
      .addSeparatorComponents(new SeparatorBuilder())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(redPacketText)
      );
  }

  container
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# RTP < 100% 表示你在賠錢，越低代表賠越多。賭多了還是會吐回去喔 🫠"
      )
    );

  return {
    useV2: true,
    components: [container],
  };
}

module.exports = { buildCasinoStatsView };
