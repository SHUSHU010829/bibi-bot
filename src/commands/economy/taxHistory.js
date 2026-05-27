// /我的稅務紀錄 — 查看個人歷史財富稅紀錄（每筆扣繳金額、稅前/稅後餘額、有效稅率與累計統計）

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
const { MONEY_EMOJI } = require("../../constants/coin");
const { DateTime } = require("luxon");

const MAX_LIST = 12;

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("我的稅務紀錄")
    .setDescription("🧾 查看你被徵收的財富稅紀錄：扣繳金額、稅前稅後餘額、有效稅率")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("period")
        .setDescription("統計期間")
        .setRequired(false)
        .addChoices(
          { name: "本月", value: "month" },
          { name: "今年", value: "year" },
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
        .find({
          userId,
          guildId,
          source: "wealth_tax",
          ...dateFilter,
        })
        .sort({ createdAt: -1 })
        .toArray();

      if (!rows.length) {
        return interaction.editReply(
          `🧾 你在這個期間（${describePeriod(period)}）沒有任何財富稅紀錄，恭喜你逃過一劫 🎉`,
        );
      }

      let totalTaxed = 0;
      let rateSum = 0;
      let rateCount = 0;
      for (const r of rows) {
        const tax = Math.abs(r.amount || 0);
        totalTaxed += tax;
        const rate = r.meta?.effectiveRate;
        if (Number.isFinite(rate)) {
          rateSum += rate;
          rateCount += 1;
        }
      }
      const avgRate = rateCount > 0 ? (rateSum / rateCount) * 100 : null;

      const latest = rows[0];
      const latestTax = Math.abs(latest.amount || 0);
      const username = interaction.member?.displayName || interaction.user.username;

      const overall =
        `**${username}** 的稅務紀錄 ・ ${describePeriod(period)}\n\n` +
        `💸 累計被課稅：**${totalTaxed.toLocaleString()}** credits（共 ${rows.length.toLocaleString()} 次）\n` +
        (avgRate !== null ? `🎯 平均有效稅率：**${avgRate.toFixed(2)}%**\n` : "") +
        `🕒 最近一次：${formatDate(latest)} ・ 扣 **${latestTax.toLocaleString()}**`;

      const listRows = rows.slice(0, MAX_LIST);
      const listLines = listRows.map((r) => {
        const tax = Math.abs(r.amount || 0);
        const before = r.meta?.before;
        const rate = r.meta?.effectiveRate;
        const ratePart = Number.isFinite(rate)
          ? ` ・ 稅率 ${(rate * 100).toFixed(2)}%`
          : "";
        const balancePart = Number.isFinite(before)
          ? `（${before.toLocaleString()} → ${(before - tax).toLocaleString()}）`
          : "";
        return `\`${formatDate(r)}\` 扣 **${tax.toLocaleString()}** ${balancePart}${ratePart}`;
      });

      const omitted = rows.length - listRows.length;
      if (omitted > 0) {
        listLines.push(`-# …還有 ${omitted.toLocaleString()} 筆較早的紀錄未顯示`);
      }

      const container = new ContainerBuilder()
        .setAccentColor(0xed4245)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("# 🧾 你的財富稅紀錄"),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large),
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(overall))
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(listLines.join("\n")),
        )
        .addSeparatorComponents(new SeparatorBuilder())
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# 財富稅每週一結算，餘額越高邊際稅率越高。想少繳稅就別囤太多金幣 ${MONEY_EMOJI}`,
          ),
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.log(`[ERROR] /我的稅務紀錄:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("❌ 查詢個人稅務紀錄時發生錯誤")
        .catch(() => {});
    }
  },
};

function getDateFilter(period) {
  const now = DateTime.now().setZone("Asia/Taipei");
  switch (period) {
    case "month":
      return { date: { $gte: now.startOf("month").toISODate() } };
    case "year":
      return { date: { $gte: now.startOf("year").toISODate() } };
    case "all":
    default:
      return {};
  }
}

function describePeriod(period) {
  switch (period) {
    case "month":
      return "本月";
    case "year":
      return "今年";
    case "all":
    default:
      return "全部時間";
  }
}

function formatDate(row) {
  if (typeof row.date === "string" && row.date) return row.date;
  if (row.createdAt) {
    return DateTime.fromJSDate(new Date(row.createdAt))
      .setZone("Asia/Taipei")
      .toISODate();
  }
  return "—";
}
