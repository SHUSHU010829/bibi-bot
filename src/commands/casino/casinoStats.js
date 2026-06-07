// /casino-stats — 全伺服器賭場統計：透過 CoinTransactions 聚合每款遊戲的下注、派彩、RTP

require("colors");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
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

const GAME_CHOICES = [
  { name: "All games", value: "all" },
  { name: "🃏 Blackjack", value: "blackjack" },
  { name: "🔼 HI-LO", value: "hilo" },
  { name: "🗺️ Keno (尋寶)", value: "keno" },
  { name: "🐉 Dragon Gate", value: "dragonGate" },
  { name: "🎡 Roulette", value: "roulette" },
  { name: "🃏 Poker", value: "poker" },
  { name: "🎰 Slot", value: "slot" },
  { name: "🎲 Sicbo", value: "sicbo" },
  { name: "🐎 Horse Racing", value: "horseRacing" },
  { name: "🎟️ Lottery", value: "lottery" },
  { name: "🚀 火箭", value: "crash" },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName("casino-stats")
    .setDescription("[ADMIN] Server-wide casino stats: bets, payouts, RTP per game")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("game")
        .setDescription("Which game to view (default: all)")
        .setRequired(false)
        .addChoices(...GAME_CHOICES),
    )
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("Stats period (default: all)")
        .setRequired(false)
        .addChoices(
          { name: "Today", value: "today" },
          { name: "This week", value: "week" },
          { name: "This month", value: "month" },
          { name: "Last 30 days", value: "all" },
        ),
    )
    .toJSON(),

  userPermissions: [PermissionFlagsBits.Administrator],

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動。");
      }

      const game = interaction.options.getString("game") || "all";
      const period = interaction.options.getString("period") || "all";
      const guildId = interaction.guildId;

      const match = {
        guildId,
        source: { $in: ["bet", "payout"] },
        ...getDateFilter(period),
      };
      if (game !== "all") {
        match["meta.game"] = game;
      }

      const rows = await client.coinTransactionsCollection
        .aggregate([
          { $match: match },
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
          `📊 ${describePeriod(period)}尚無${game === "all" ? "賭場" : (GAME_LABELS[game] || game)}紀錄。`,
        );
      }

      const perGame = {};
      let totalWagered = 0;
      let totalPayout = 0;
      let totalBetCount = 0;

      for (const r of rows) {
        const g = r._id.game || "unknown";
        if (!perGame[g]) perGame[g] = { wagered: 0, payout: 0, betCount: 0 };
        if (r._id.source === "bet") {
          perGame[g].wagered += Math.abs(r.total);
          perGame[g].betCount += r.count;
          totalWagered += Math.abs(r.total);
          totalBetCount += r.count;
        } else if (r._id.source === "payout") {
          perGame[g].payout += r.total;
          totalPayout += r.total;
        }
      }

      const netProfit = totalPayout - totalWagered;
      const overallRtp = totalWagered > 0 ? (totalPayout / totalWagered) * 100 : 0;

      const titleScope = game === "all" ? "All Games" : (GAME_LABELS[game] || game);
      const overall =
        `**📈 ${describePeriod(period)} ・ ${titleScope}**\n` +
        `🎮 Bets placed: **${totalBetCount.toLocaleString()}**\n` +
        `💸 Total wagered: **${totalWagered.toLocaleString()}** credits\n` +
        `${MONEY_EMOJI} Total payout: **${totalPayout.toLocaleString()}** credits\n` +
        `${netProfit >= 0 ? "📈" : "📉"} Player net: **${netProfit >= 0 ? "+" : ""}${netProfit.toLocaleString()}**\n` +
        `🎯 RTP: **${overallRtp.toFixed(1)}%**${overallRtp < 100 ? "（House wins）" : "（Players ahead）"}`;

      const sortedGames = Object.entries(perGame).sort(
        (a, b) => b[1].wagered - a[1].wagered,
      );
      const perGameLines = sortedGames.map(([g, s]) => {
        const label = GAME_LABELS[g] || `❓ ${g}`;
        const net = s.payout - s.wagered;
        const rtp = s.wagered > 0 ? (s.payout / s.wagered) * 100 : 0;
        return (
          `${label}\n` +
          `-# Wagered ${s.wagered.toLocaleString()}（${s.betCount} bets）・ Payout ${s.payout.toLocaleString()}\n` +
          `-# Net ${net >= 0 ? "+" : ""}${net.toLocaleString()}　・　RTP ${rtp.toFixed(1)}%`
        );
      });

      const accent = netProfit >= 0 ? 0x2ecc71 : 0xe74c3c;

      const container = new ContainerBuilder()
        .setAccentColor(accent)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 📊 Casino Stats"),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(overall),
        );

      if (game === "all" && perGameLines.length > 1) {
        container
          .addSeparatorComponents(new SeparatorBuilder())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(perGameLines.join("\n\n")),
          );
      }

      container
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Period: ${describePeriod(period)} ・ <t:${Math.floor(Date.now() / 1000)}:R>\n` +
              `-# Source: CoinTransactions（bet/payout，最多保留 30 天）`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /casino-stats:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("❌ Failed to fetch casino stats")
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
      return "Today";
    case "week":
      return "This week";
    case "month":
      return "This month";
    case "all":
    default:
      return "Last 30 days";
  }
}
