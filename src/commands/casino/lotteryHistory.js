// /樂透歷史 — 查看自己全部的樂透票券與開獎結果(分頁瀏覽 + 篩選)。

require("colors");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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

const TYPE_LABEL = {
  "6_49": "大樂透",
  "3_20": "小樂透",
};

const RESULT_LABEL = {
  won: "中獎",
  lost: "未中",
  pending: "等開獎",
};

const TIMEOUT_MS = 3 * 60 * 1000;
const PAGE_SIZE = 15;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("樂透歷史")
    .setDescription("查看自己全部的樂透紀錄 📚")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!client.lotteryTicketsCollection) {
        return interaction.editReply("🔧 樂透系統尚未啟動。");
      }

      const pageSize = PAGE_SIZE;
      const baseFilter = {
        userId: interaction.user.id,
        guildId: interaction.guildId,
      };

      const grandTotal =
        await client.lotteryTicketsCollection.countDocuments(baseFilter);
      if (grandTotal === 0) {
        return interaction.editReply("你還沒買過任何樂透票!");
      }

      // 依目前篩選條件組出 MongoDB 查詢。
      // 「結果」篩選需要對照開獎期別狀態:中獎只看 prize,未中/等開獎則需區分該期是否已開獎。
      const buildMongoFilter = async (filters) => {
        const f = { ...baseFilter };
        if (filters.lotteryType) f.lotteryType = filters.lotteryType;
        if (filters.source) f.source = filters.source;

        if (filters.result === "won") {
          f.prize = { $ne: null };
        } else if (filters.result === "lost" || filters.result === "pending") {
          const prelim = { ...baseFilter };
          if (filters.lotteryType) prelim.lotteryType = filters.lotteryType;
          if (filters.source) prelim.source = filters.source;

          const drawIds = await client.lotteryTicketsCollection.distinct(
            "drawId",
            prelim
          );
          const draws = await client.lotteryDrawsCollection
            .find(
              { drawId: { $in: drawIds } },
              { projection: { drawId: 1, status: 1 } }
            )
            .toArray();

          if (filters.result === "lost") {
            f.drawId = {
              $in: draws
                .filter((d) => d.status === "settled")
                .map((d) => d.drawId),
            };
            f.prize = null;
          } else {
            f.drawId = {
              $in: draws
                .filter((d) => d.status !== "settled")
                .map((d) => d.drawId),
            };
          }
        }
        return f;
      };

      // 計算目前篩選下的總筆數、統計與頁數,並夾住頁碼。
      const computeView = async (filters, desiredPage) => {
        const mongoFilter = await buildMongoFilter(filters);
        const total =
          await client.lotteryTicketsCollection.countDocuments(mongoFilter);
        const [agg] = await client.lotteryTicketsCollection
          .aggregate([
            { $match: mongoFilter },
            {
              $group: {
                _id: null,
                spent: { $sum: "$pricePaid" },
                won: { $sum: "$payoutAmount" },
              },
            },
          ])
          .toArray();
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(Math.max(0, desiredPage), totalPages - 1);
        return { filters, mongoFilter, total, agg, totalPages, page };
      };

      const filterHeader = (filters) =>
        "🔍 " +
        [
          `玩法:${filters.lotteryType ? TYPE_LABEL[filters.lotteryType] : "全部"}`,
          `來源:${filters.source ? SOURCE_LABEL[filters.source] : "全部"}`,
          `結果:${filters.result ? RESULT_LABEL[filters.result] : "全部"}`,
        ].join(" ・ ");

      const renderContent = async (view, { showFilter }) => {
        const { mongoFilter, total, agg, totalPages, page, filters } = view;
        const header = showFilter ? `${filterHeader(filters)}\n` : "";

        if (total === 0) {
          return `${header}\n沒有符合篩選條件的紀錄,換個條件試試 👀`;
        }

        const tickets = await client.lotteryTicketsCollection
          .find(mongoFilter)
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

        const spent = agg?.spent || 0;
        const won = agg?.won || 0;
        const summaryLine =
          `總筆數:${total} ・ 總花費:${spent.toLocaleString()} ・ ` +
          `總獎金:${won.toLocaleString()} ・ ` +
          `淨值:${(won - spent).toLocaleString()}`;

        return (
          `${header}📚 **第 ${page + 1} / ${totalPages} 頁**\n\n` +
          `${lines.join("\n")}\n\n${summaryLine}`
        );
      };

      // ── 單頁(全部紀錄就一頁)直接顯示,不需互動元件 ──
      if (grandTotal <= pageSize) {
        const view = await computeView(
          { lotteryType: null, source: null, result: null },
          0
        );
        return interaction.editReply(
          await renderContent(view, { showFilter: false })
        );
      }

      // ── 多頁:提供篩選下拉 + 分頁按鈕 ──
      const buildTypeSelect = (filters, disabled) =>
        new StringSelectMenuBuilder()
          .setCustomId("lh_filter_type")
          .setPlaceholder("玩法篩選")
          .setDisabled(disabled)
          .addOptions(
            { label: "全部玩法", value: "all", default: !filters.lotteryType },
            {
              label: "大樂透 6/49",
              value: "6_49",
              emoji: "🎰",
              default: filters.lotteryType === "6_49",
            },
            {
              label: "小樂透 3/20",
              value: "3_20",
              emoji: "🎫",
              default: filters.lotteryType === "3_20",
            }
          );

      const buildSourceSelect = (filters, disabled) =>
        new StringSelectMenuBuilder()
          .setCustomId("lh_filter_source")
          .setPlaceholder("來源篩選")
          .setDisabled(disabled)
          .addOptions(
            { label: "全部來源", value: "all", default: !filters.source },
            { label: "手買", value: "manual", default: filters.source === "manual" },
            {
              label: "訂閱",
              value: "subscription",
              default: filters.source === "subscription",
            },
            {
              label: "包牌",
              value: "wheeling",
              default: filters.source === "wheeling",
            },
            { label: "自動", value: "auto", default: filters.source === "auto" }
          );

      const buildResultSelect = (filters, disabled) =>
        new StringSelectMenuBuilder()
          .setCustomId("lh_filter_result")
          .setPlaceholder("結果篩選")
          .setDisabled(disabled)
          .addOptions(
            { label: "全部結果", value: "all", default: !filters.result },
            {
              label: "中獎",
              value: "won",
              emoji: "🎉",
              default: filters.result === "won",
            },
            { label: "未中", value: "lost", default: filters.result === "lost" },
            {
              label: "等開獎",
              value: "pending",
              emoji: "⏳",
              default: filters.result === "pending",
            }
          );

      const buildComponents = (view, disabled = false) => [
        new ActionRowBuilder().addComponents(
          buildTypeSelect(view.filters, disabled)
        ),
        new ActionRowBuilder().addComponents(
          buildSourceSelect(view.filters, disabled)
        ),
        new ActionRowBuilder().addComponents(
          buildResultSelect(view.filters, disabled)
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("lh_prev")
            .setLabel("◀ 上一頁")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || view.page === 0),
          new ButtonBuilder()
            .setCustomId("lh_page")
            .setLabel(`${view.page + 1}/${view.totalPages}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId("lh_next")
            .setLabel("下一頁 ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || view.page >= view.totalPages - 1)
        ),
      ];

      let view = await computeView(
        { lotteryType: null, source: null, result: null },
        0
      );

      const message = await interaction.editReply({
        content: await renderContent(view, { showFilter: true }),
        components: buildComponents(view),
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

          const filters = { ...view.filters };
          let desiredPage = view.page;

          if (i.customId === "lh_prev") {
            desiredPage = view.page - 1;
          } else if (i.customId === "lh_next") {
            desiredPage = view.page + 1;
          } else if (i.customId === "lh_filter_type") {
            const v = i.values[0];
            filters.lotteryType = v === "all" ? null : v;
            desiredPage = 0;
          } else if (i.customId === "lh_filter_source") {
            const v = i.values[0];
            filters.source = v === "all" ? null : v;
            desiredPage = 0;
          } else if (i.customId === "lh_filter_result") {
            const v = i.values[0];
            filters.result = v === "all" ? null : v;
            desiredPage = 0;
          }

          view = await computeView(filters, desiredPage);

          await interaction.editReply({
            content: await renderContent(view, { showFilter: true }),
            components: buildComponents(view),
          });
          collector.resetTimer();
        } catch (err) {
          console.log(`[ERROR] /樂透歷史 互動處理失敗:${err}`.red);
        }
      });

      collector.on("end", async () => {
        try {
          await interaction.editReply({
            content: await renderContent(view, { showFilter: true }),
            components: buildComponents(view, true),
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
