// /我的賭場紀錄 — 個人賭場統計（總下注、總派彩、RTP、各遊戲分項）

require("colors");
const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { DateTime } = require("luxon");

const GAME_LABELS = {
  slot: "🎰 拉霸",
  sicbo: "🎲 骰寶",
  blackjack: "🃏 21 點",
  hilo: "🔼 HI-LO",
  keno: "🗺️ 尋寶",
  dragonGate: "🐉 射龍門",
  roulette: "🎡 輪盤",
  poker: "🃏 德州撲克",
  lottery: "🎟️ 樂透",
  horseRacing: "🐎 賽馬",
  crash: "🚀 火箭",
  unknown: "❓ 未分類",
};

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("我的賭場紀錄")
    .setDescription("📊 查看你個人的賭場統計：下注、派彩、RTP、各遊戲分項")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("統計期間")
        .setRequired(false)
        .addChoices(
          { name: "今天", value: "today" },
          { name: "本週", value: "week" },
          { name: "本月", value: "month" },
          { name: "全部", value: "all" },
        ),
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動。");
      }

      const period = interaction.options.getString("period") || "all";
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const dateFilter = getDateFilter(period);

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
        return interaction.editReply(
          `📊 你在這個期間（${describePeriod(period)}）還沒有任何賭場紀錄。`,
        );
      }

      // 彙整：per-game wagered/payout
      const perGame = {};
      let totalWagered = 0;
      let totalPayout = 0;
      let totalBetCount = 0;

      for (const r of rows) {
        const game = r._id.game || "unknown";
        const src = r._id.source;
        if (!perGame[game]) perGame[game] = { wagered: 0, payout: 0, betCount: 0 };
        if (src === "bet") {
          perGame[game].wagered += Math.abs(r.total);
          perGame[game].betCount += r.count;
          totalWagered += Math.abs(r.total);
          totalBetCount += r.count;
        } else if (src === "payout") {
          perGame[game].payout += r.total;
          totalPayout += r.total;
        }
      }

      const netProfit = totalPayout - totalWagered;
      const overallRtp = totalWagered > 0 ? (totalPayout / totalWagered) * 100 : 0;
      const username = interaction.member?.displayName || interaction.user.username;

      const overall =
        `**${username}** 的賭場紀錄 ・ ${describePeriod(period)}\n\n` +
        `💸 總下注：**${totalWagered.toLocaleString()}** credits（共 ${totalBetCount.toLocaleString()} 注）\n` +
        `💰 總派彩：**${totalPayout.toLocaleString()}** credits\n` +
        `${netProfit >= 0 ? "📈" : "📉"} 淨輸贏：**${netProfit >= 0 ? "+" : ""}${netProfit.toLocaleString()}**\n` +
        `🎯 RTP（回收率）：**${overallRtp.toFixed(1)}%**${overallRtp < 100 ? "（賠錢中）" : "（賺錢中）"}`;

      const games = Object.entries(perGame)
        .sort((a, b) => b[1].wagered - a[1].wagered);
      const perGameLines = games.map(([game, s]) => {
        const label = GAME_LABELS[game] || `❓ ${game}`;
        const net = s.payout - s.wagered;
        const rtp = s.wagered > 0 ? (s.payout / s.wagered) * 100 : 0;
        return (
          `${label}\n` +
          `-# 下注 ${s.wagered.toLocaleString()}（${s.betCount} 注）・ 派彩 ${s.payout.toLocaleString()}\n` +
          `-# 淨 ${net >= 0 ? "+" : ""}${net.toLocaleString()}　・　RTP ${rtp.toFixed(1)}%`
        );
      });

      const accent = netProfit >= 0 ? 0x2ecc71 : 0xe74c3c;

      const container = new ContainerBuilder()
        .setAccentColor(accent)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 📊 你的賭場紀錄"),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(overall),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(perGameLines.join("\n\n")),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# RTP < 100% 表示你在賠錢，越低代表賠越多。賭多了還是會吐回去喔 🫠`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /我的賭場紀錄:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("❌ 查詢個人賭場紀錄時發生錯誤")
        .catch(() => {});
    }
  },
};

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
