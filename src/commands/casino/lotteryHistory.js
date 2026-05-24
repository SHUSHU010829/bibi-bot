// /樂透歷史 — 查看自己全部的樂透票券與開獎結果(分頁瀏覽)。

require("colors");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { getLotteryConfig } = require("../../features/casino/lottery/numbers");

const PRIZE_LABEL = {
  jackpot: "🎉 頭獎",
  second: "💎 二獎",
  third: "🥉 三獎",
  fourth: "🎯 四獎",
};

const SOURCE_LABEL = {
  manual: "手買",
  subscription: "訂閱",
  wheeling: "包牌",
  auto: "自動",
};

const TIMEOUT_MS = 3 * 60 * 1000;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("樂透歷史")
    .setDescription("查看自己全部的樂透紀錄 📚")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o
        .setName("每頁筆數")
        .setDescription("每頁顯示筆數(預設 15)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.lotteryTicketsCollection) {
        return interaction.editReply("🔧 樂透系統尚未啟動。");
      }

      const pageSize = interaction.options.getInteger("每頁筆數") || 15;
      const filter = {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      };

      const total = await client.lotteryTicketsCollection.countDocuments(filter);
      if (total === 0) {
        return interaction.editReply("你還沒買過任何樂透票!");
      }

      // 整體統計(涵蓋全部紀錄,不只當前頁)
      const [agg] = await client.lotteryTicketsCollection
        .aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              spent: { $sum: "$pricePaid" },
              won: { $sum: "$payoutAmount" },
            },
          },
        ])
        .toArray();
      const grandSpent = agg?.spent || 0;
      const grandWon = agg?.won || 0;
      const summaryLine =
        `總筆數:${total} ・ 總花費:${grandSpent.toLocaleString()} ・ ` +
        `總獎金:${grandWon.toLocaleString()} ・ ` +
        `淨值:${(grandWon - grandSpent).toLocaleString()}`;

      const totalPages = Math.ceil(total / pageSize);

      const renderPage = async (page) => {
        const tickets = await client.lotteryTicketsCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(page * pageSize)
          .limit(pageSize)
          .toArray();

        const drawIds = [...new Set(tickets.map((t) => t.drawId))];
        const draws = await client.lotteryDrawsCollection
          .find({ drawId: { $in: drawIds } })
          .toArray();
        const drawById = new Map(draws.map((d) => [d.drawId, d]));

        const lines = tickets.map((t) => {
          const cfg = getLotteryConfig(t.lotteryType);
          const draw = drawById.get(t.drawId);
          const numStr = t.numbers.join(" ・ ");
          const status =
            draw?.status === "settled"
              ? t.prize
                ? `${PRIZE_LABEL[t.prize] || t.prize} +${(t.payoutAmount || 0).toLocaleString()}`
                : `沒中(中 ${t.matched || 0})`
              : "等開獎";
          const sourceTag = SOURCE_LABEL[t.source] || t.source;
          return `\`${draw?.drawNumber ?? "?"}\` ${cfg?.emoji || "🎟"} ${numStr} ・ ${sourceTag} ・ ${status}`;
        });

        return (
          `📚 **第 ${page + 1} / ${totalPages} 頁**\n\n` +
          `${lines.join("\n")}\n\n${summaryLine}`
        );
      };

      const buildRow = (page, disabled = false) =>
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("lh_prev")
            .setLabel("◀ 上一頁")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page === 0),
          new ButtonBuilder()
            .setCustomId("lh_page")
            .setLabel(`${page + 1}/${totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId("lh_next")
            .setLabel("下一頁 ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page >= totalPages - 1)
        );

      let page = 0;

      // 只有一頁時不需要分頁按鈕
      if (totalPages === 1) {
        return interaction.editReply(await renderPage(page));
      }

      const message = await interaction.editReply({
        content: await renderPage(page),
        components: [buildRow(page)],
      });

      const collector = message.createMessageComponentCollector({
        time: TIMEOUT_MS,
      });

      collector.on("collect", async (i) => {
        if (i.user.id !== interaction.user.id) {
          return i.reply({
            content: "🚫 只有發起者能操作這個選單!",
            flags: MessageFlags.Ephemeral,
          });
        }

        try {
          await i.deferUpdate();

          if (i.customId === "lh_prev") {
            page = Math.max(0, page - 1);
          } else if (i.customId === "lh_next") {
            page = Math.min(totalPages - 1, page + 1);
          }

          await interaction.editReply({
            content: await renderPage(page),
            components: [buildRow(page)],
          });
          collector.resetTimer();
        } catch (err) {
          console.log(`[ERROR] /樂透歷史 互動處理失敗:${err}`.red);
        }
      });

      collector.on("end", async () => {
        try {
          await interaction.editReply({
            content: await renderPage(page),
            components: [buildRow(page, true)],
          });
        } catch {
          /* 訊息可能已被刪除,忽略 */
        }
      });
    } catch (err) {
      console.log(`[ERROR] /樂透歷史:\n${err}\n${err.stack}`.red);
      await interaction.editReply("🔧 查詢失敗。").catch(() => {});
    }
  },
};
