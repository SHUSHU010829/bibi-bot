// /樂透 — 整合樂透相關子指令（買 / 包牌 / 資訊 / 歷史 / 訂閱 開啟・列表・關閉）。
//
// 各子指令的實作邏輯維持與原本獨立指令相同；這個檔案只負責 SlashCommandBuilder 與 dispatch。

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  getLotteryConfig,
  pickRandomNumbers,
  validateNumbers,
  validateWheelingNumbers,
  listLotteryTypes,
} = require("../../features/casino/lottery/numbers");
const {
  calculateWheelingCost,
  expandWheel,
} = require("../../features/casino/lottery/wheeling");
const {
  getCurrentOpenDraw,
  ensureNextDraw,
} = require("../../features/casino/lottery/runDraw");
const {
  checkAndAnnouncePoolMilestones,
} = require("../../features/casino/lottery/poolAnnouncer");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const twitchPerks = require("../../features/mining/twitchPerks");

const TYPE_CHOICES = [
  { name: "大樂透 6/49", value: "6_49" },
  { name: "小樂透 3/20", value: "3_20" },
];

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
const TYPE_LABEL = { "6_49": "大樂透", "3_20": "小樂透" };
const RESULT_LABEL = { won: "中獎", lost: "未中", pending: "等開獎" };

const HISTORY_TIMEOUT_MS = 3 * 60 * 1000;
const HISTORY_PAGE_SIZE = 15;

function getLotteryFeatureConfig() {
  return casino?.lottery || {};
}
function getTypeConfig(t) {
  return getLotteryFeatureConfig().types?.[t] || {};
}
function getSubConfig() {
  return casino?.lottery?.subscription || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("樂透")
    .setDescription("樂透系統 🎟")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("購買")
        .setDescription("買樂透票 🎟")
        .addStringOption((o) =>
          o
            .setName("玩法")
            .setDescription("玩法")
            .setRequired(true)
            .addChoices(...TYPE_CHOICES)
        )
        .addIntegerOption((o) =>
          o
            .setName("張數")
            .setDescription("買幾張(隨機選號模式才用)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100)
        )
        .addStringOption((o) =>
          o
            .setName("號碼")
            .setDescription("自選號碼(空白/逗號分隔,留空則隨機)")
            .setRequired(false)
        )
    )
    .addSubcommand((s) =>
      s
        .setName("包牌")
        .setDescription("包牌:選 7-N 個號碼自動展開所有組合 🎯")
        .addStringOption((o) =>
          o
            .setName("玩法")
            .setDescription("玩法(目前只支援大樂透)")
            .setRequired(true)
            .addChoices({ name: "大樂透 6/49", value: "6_49" })
        )
        .addStringOption((o) =>
          o
            .setName("號碼")
            .setDescription("7 個以上號碼,空白/逗號分隔")
            .setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s.setName("資訊").setDescription("查看當期樂透資訊 ℹ️")
    )
    .addSubcommand((s) =>
      s.setName("歷史").setDescription("查看自己全部的樂透紀錄 📚")
    )
    .addSubcommandGroup((g) =>
      g
        .setName("訂閱")
        .setDescription("樂透訂閱:自動買票 🔁")
        .addSubcommand((s) =>
          s
            .setName("開啟")
            .setDescription("建立新訂閱,未來 N 期自動買同組號碼")
            .addStringOption((o) =>
              o
                .setName("玩法")
                .setDescription("玩法")
                .setRequired(true)
                .addChoices(...TYPE_CHOICES)
            )
            .addIntegerOption((o) =>
              o
                .setName("期數")
                .setDescription("自動買幾期")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(12)
            )
            .addIntegerOption((o) =>
              o
                .setName("每期張數")
                .setDescription("每期買幾張")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10)
            )
            .addStringOption((o) =>
              o
                .setName("號碼")
                .setDescription("自選號碼(空白/逗號分隔,留空則隨機)")
                .setRequired(false)
            )
        )
        .addSubcommand((s) =>
          s.setName("列表").setDescription("查看與管理自己的樂透訂閱 📋")
        )
        .addSubcommand((s) =>
          s.setName("關閉").setDescription("一次取消所有進行中的訂閱 🛑")
        )
    )
    .toJSON(),

  run: async (client, interaction) => {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === "訂閱") {
      if (sub === "開啟") return runSubscribe(client, interaction);
      if (sub === "列表") return runSubscriptions(client, interaction);
      if (sub === "關閉") return runUnsubscribeAll(client, interaction);
    }
    if (sub === "購買" || sub === "買") return runBuy(client, interaction);
    if (sub === "包牌") return runWheel(client, interaction);
    if (sub === "資訊") return runStatus(client, interaction);
    if (sub === "歷史") return runHistory(client, interaction);
  },
};

// ───────────────────────────── /樂透 購買 ─────────────────────────────
async function runBuy(client, interaction) {
  await interaction.deferReply();

  try {
    if (!coinSystem?.enabled) {
      return interaction.editReply("🔧 金幣系統尚未啟動!");
    }
    if (!client.userCoinsCollection || !client.lotteryTicketsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動,請聯絡舒舒!");
    }

    const lcfg = getLotteryFeatureConfig();
    if (!lcfg.enabled) {
      return interaction.editReply("🔧 樂透暫時關閉中!");
    }

    const lotteryType = interaction.options.getString("玩法");
    const typeCfg = getTypeConfig(lotteryType);
    if (!typeCfg.enabled) {
      return interaction.editReply("🔧 該樂透玩法暫時關閉!");
    }

    const cfg = getLotteryConfig(lotteryType);
    if (!cfg) {
      return interaction.editReply("🔧 玩法不存在!");
    }

    const ticketCountInput = interaction.options.getInteger("張數");
    const numbersInput = interaction.options.getString("號碼");
    const ticketPrice = typeCfg.ticketPrice || 0;
    const maxTicketsPerOrder = typeCfg.maxTicketsPerOrder || 100;

    let numbersList = [];
    if (numbersInput && numbersInput.trim()) {
      const v = validateNumbers(numbersInput, lotteryType);
      if (!v.ok) {
        return interaction.editReply(`❌ ${v.error}`);
      }
      const count = ticketCountInput || 1;
      if (count > maxTicketsPerOrder) {
        return interaction.editReply(
          `❌ 單筆最多買 ${maxTicketsPerOrder} 張票`
        );
      }
      for (let i = 0; i < count; i++) numbersList.push([...v.numbers]);
    } else {
      const count = ticketCountInput || 1;
      if (count > maxTicketsPerOrder) {
        return interaction.editReply(
          `❌ 單筆最多買 ${maxTicketsPerOrder} 張票`
        );
      }
      for (let i = 0; i < count; i++) {
        numbersList.push(pickRandomNumbers(cfg.pickCount, cfg.range));
      }
    }

    const totalCost = numbersList.length * ticketPrice;

    let draw = await getCurrentOpenDraw(client, lotteryType);
    if (!draw) draw = await ensureNextDraw(client, lotteryType);
    if (!draw) {
      return interaction.editReply("🔧 暫時無法取得當期樂透,請稍後再試。");
    }

    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const username = interaction.member?.displayName || interaction.user.username;
    const member = interaction.member;

    const before = await client.userCoinsCollection.findOne({ userId, guildId });
    const balance = before?.totalCoins || 0;
    if (balance < totalCost) {
      return interaction.editReply(
        `${MONEY_EMOJI} 餘額不足!目前 **${balance.toLocaleString()}** credits,需要 ${totalCost.toLocaleString()}。`
      );
    }

    const orderId = crypto.randomUUID();

    const betResult = await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash: interaction.user.avatar,
      amount: -totalCost,
      source: "bet",
      member,
      meta: {
        game: "lottery",
        lotteryType,
        drawId: draw.drawId,
        orderId,
        ticketCount: numbersList.length,
      },
    });
    if (!betResult) {
      return interaction.editReply("🔧 扣款失敗,請稍後再試。");
    }

    const ticketDocs = numbersList.map((nums) => ({
      ticketId: crypto.randomUUID(),
      drawId: draw.drawId,
      lotteryType,
      userId,
      guildId,
      username,
      numbers: nums,
      pricePaid: ticketPrice,
      source: "manual",
      subscriptionId: null,
      wheelingId: null,
      matched: 0,
      prize: null,
      payoutAmount: 0,
      createdAt: new Date(),
    }));
    await client.lotteryTicketsCollection.insertMany(ticketDocs);

    const updated = await client.lotteryDrawsCollection.findOneAndUpdate(
      { _id: draw._id },
      {
        $inc: {
          pool: totalCost,
          totalRevenue: totalCost,
          totalTickets: numbersList.length,
        },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" }
    );

    const drawDoc = updated?.value || updated;
    if (drawDoc) {
      checkAndAnnouncePoolMilestones(client, drawDoc._id).catch((e) =>
        console.log(`[LOTTERY] milestone check failed: ${e}`.yellow)
      );
    }

    const balanceAfter = betResult.doc?.totalCoins ?? balance - totalCost;
    const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);

    const previewLines = ticketDocs
      .slice(0, 10)
      .map((t, i) => `\`${String(i + 1).padStart(2, " ")}.\` ${t.numbers.join(" ・ ")}`)
      .join("\n");
    const moreLine =
      ticketDocs.length > 10 ? `\n…再 ${ticketDocs.length - 10} 張` : "";

    await saveLastBet(client, {
      userId,
      guildId,
      game: "lottery",
      payload: {
        options: {
          __subcommand: "購買",
          玩法: lotteryType,
          張數: ticketCountInput,
          號碼: numbersInput,
        },
      },
    });

    await interaction.editReply({
      content:
        `${cfg.emoji} **${cfg.label}** 第 ${draw.drawNumber} 期 已買 **${ticketDocs.length}** 張\n` +
        `${previewLines}${moreLine}\n\n` +
        `花費:**${totalCost.toLocaleString()}** ・ 餘額:**${balanceAfter.toLocaleString()}**\n` +
        `當前彩池:**${(drawDoc?.pool || draw.pool + totalCost).toLocaleString()}** credits\n` +
        `開獎時間:<t:${drawAtUnix}:R>`,
      components: [
        buildReplayRow("lottery", interaction.user.id, {
          label: "🔁 再買一單",
          name: username,
        }),
      ],
    });
  } catch (err) {
    console.log(`[ERROR] /樂透 購買:\n${err}\n${err.stack}`.red);
    await interaction
      .editReply("🔧 樂透買票執行失敗,請呼叫舒舒!")
      .catch(() => {});
  }
}

// ───────────────────────────── /樂透 包牌 ─────────────────────────────
async function runWheel(client, interaction) {
  await interaction.deferReply();

  try {
    if (!coinSystem?.enabled) {
      return interaction.editReply("🔧 金幣系統尚未啟動!");
    }
    if (
      !client.userCoinsCollection ||
      !client.lotteryTicketsCollection ||
      !client.lotteryWheelsCollection
    ) {
      return interaction.editReply("🔧 樂透系統尚未啟動,請聯絡舒舒!");
    }

    const lcfg = casino?.lottery;
    if (!lcfg?.enabled) {
      return interaction.editReply("🔧 樂透暫時關閉中!");
    }

    const lotteryType = interaction.options.getString("玩法");
    const typeCfg = getTypeConfig(lotteryType);
    if (!typeCfg.enabled) {
      return interaction.editReply("🔧 該玩法暫時關閉!");
    }
    if (!typeCfg.wheelingEnabled) {
      return interaction.editReply("❌ 該玩法不支援包牌");
    }

    const cfg = getLotteryConfig(lotteryType);
    const maxBase = typeCfg.wheelingMaxBaseNumbers || 10;
    const ticketPrice = typeCfg.ticketPrice || 0;

    const numbersInput = interaction.options.getString("號碼");
    const v = validateWheelingNumbers(numbersInput, lotteryType, maxBase);
    if (!v.ok) {
      return interaction.editReply(`❌ ${v.error}`);
    }

    const baseNumbers = v.numbers;
    const { combinations, totalCost } = calculateWheelingCost(
      baseNumbers.length,
      lotteryType,
      ticketPrice
    );

    let draw = await getCurrentOpenDraw(client, lotteryType);
    if (!draw) draw = await ensureNextDraw(client, lotteryType);
    if (!draw) {
      return interaction.editReply("🔧 暫時無法取得當期樂透。");
    }

    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const username = interaction.member?.displayName || interaction.user.username;

    const before = await client.userCoinsCollection.findOne({ userId, guildId });
    const balance = before?.totalCoins || 0;
    if (balance < totalCost) {
      return interaction.editReply(
        `${MONEY_EMOJI} 餘額不足!包牌 ${baseNumbers.length} 個號碼產生 ${combinations} 組,需要 ${totalCost.toLocaleString()},目前 ${balance.toLocaleString()}。`
      );
    }

    const wheelingId = crypto.randomUUID();

    const betResult = await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash: interaction.user.avatar,
      amount: -totalCost,
      source: "bet",
      member: interaction.member,
      meta: {
        game: "lottery",
        lotteryType,
        drawId: draw.drawId,
        wheelingId,
        baseNumbers,
        combinations,
      },
    });
    if (!betResult) {
      return interaction.editReply("🔧 扣款失敗。");
    }

    const combos = expandWheel(baseNumbers, lotteryType);
    const ticketDocs = combos.map((nums) => ({
      ticketId: crypto.randomUUID(),
      drawId: draw.drawId,
      lotteryType,
      userId,
      guildId,
      username,
      numbers: nums,
      pricePaid: ticketPrice,
      source: "wheeling",
      subscriptionId: null,
      wheelingId,
      matched: 0,
      prize: null,
      payoutAmount: 0,
      createdAt: new Date(),
    }));

    await client.lotteryTicketsCollection.insertMany(ticketDocs);
    await client.lotteryWheelsCollection.insertOne({
      wheelingId,
      drawId: draw.drawId,
      lotteryType,
      userId,
      guildId,
      username,
      baseNumbers,
      combinationCount: combinations,
      pricePaid: totalCost,
      ticketIds: ticketDocs.map((t) => t.ticketId),
      totalWon: 0,
      bestPrize: null,
      createdAt: new Date(),
    });

    const updated = await client.lotteryDrawsCollection.findOneAndUpdate(
      { _id: draw._id },
      {
        $inc: {
          pool: totalCost,
          totalRevenue: totalCost,
          totalTickets: combinations,
        },
        $set: { updatedAt: new Date() },
      },
      { returnDocument: "after" }
    );

    const drawDoc = updated?.value || updated;
    if (drawDoc) {
      checkAndAnnouncePoolMilestones(client, drawDoc._id).catch((e) =>
        console.log(`[LOTTERY] milestone check failed: ${e}`.yellow)
      );
    }

    const balanceAfter = betResult.doc?.totalCoins ?? balance - totalCost;
    const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);

    await interaction.editReply(
      `${cfg.emoji} **${cfg.label}** 包牌成功!\n` +
        `Base 號碼:${baseNumbers.join(" ・ ")}\n` +
        `展開組合:**${combinations}** 組\n` +
        `花費:**${totalCost.toLocaleString()}** ・ 餘額:**${balanceAfter.toLocaleString()}**\n` +
        `當前彩池:**${(drawDoc?.pool || draw.pool + totalCost).toLocaleString()}** credits\n` +
        `開獎時間:<t:${drawAtUnix}:R>`
    );
  } catch (err) {
    console.log(`[ERROR] /樂透 包牌:\n${err}\n${err.stack}`.red);
    await interaction
      .editReply("🔧 包牌執行失敗,請呼叫舒舒!")
      .catch(() => {});
  }
}

// ───────────────────────────── /樂透 資訊 ─────────────────────────────
async function runStatus(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.lotteryDrawsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動。");
    }

    const lines = [];
    for (const t of listLotteryTypes()) {
      const cfg = getLotteryConfig(t);
      const draw = await client.lotteryDrawsCollection.findOne({
        lotteryType: t,
        status: "open",
      });
      if (!draw) {
        lines.push(`${cfg.emoji} **${cfg.label}**:當期尚未開放`);
        continue;
      }
      const drawAtUnix = Math.floor(new Date(draw.scheduledAt).getTime() / 1000);
      const userTickets = await client.lotteryTicketsCollection.countDocuments({
        drawId: draw.drawId,
        userId: interaction.user.id,
      });
      lines.push(
        `${cfg.emoji} **${cfg.label}** 第 ${draw.drawNumber} 期\n` +
          `彩池:**${draw.pool.toLocaleString()}** credits\n` +
          `總票數:${draw.totalTickets || 0}(你有 ${userTickets} 張)\n` +
          `開獎倒數:<t:${drawAtUnix}:R>`
      );
    }

    await interaction.editReply(lines.join("\n\n"));
  } catch (err) {
    console.log(`[ERROR] /樂透 資訊:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 查詢失敗。").catch(() => {});
  }
}

// ───────────────────────────── /樂透 歷史 ─────────────────────────────
async function runHistory(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.lotteryTicketsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動。");
    }

    const pageSize = HISTORY_PAGE_SIZE;
    const baseFilter = {
      userId: interaction.user.id,
      guildId: interaction.guildId,
    };

    const grandTotal =
      await client.lotteryTicketsCollection.countDocuments(baseFilter);
    if (grandTotal === 0) {
      return interaction.editReply("你還沒買過任何樂透票!");
    }

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
              won: {
                $sum: { $add: ["$payoutAmount", { $ifNull: ["$bonusPayout", 0] }] },
              },
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
        const bonusTags = [];
        if (t.bonusFlags?.bonusBall) bonusTags.push("🎯加碼球");
        if (t.bonusFlags?.consecutive) bonusTags.push("🔗連號");
        const bonusStr =
          (t.bonusPayout || 0) > 0
            ? ` ・ ${bonusTags.join("")} +${t.bonusPayout.toLocaleString()}`
            : "";
        const status =
          draw?.status === "settled"
            ? t.prize
              ? `${PRIZE_LABEL[t.prize] || t.prize} +${(t.payoutAmount || 0).toLocaleString()}`
              : `沒中(中 ${t.matched || 0})`
            : "等開獎";
        const sourceTag = SOURCE_LABEL[t.source] || t.source;
        return `\`${draw?.drawNumber ?? "?"}\` ${cfg?.emoji || "🎟"} ${numStr} ・ ${sourceTag} ・ ${status}${bonusStr}`;
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

    if (grandTotal <= pageSize) {
      const view = await computeView(
        { lotteryType: null, source: null, result: null },
        0
      );
      return interaction.editReply(
        await renderContent(view, { showFilter: false })
      );
    }

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
      new ActionRowBuilder().addComponents(buildTypeSelect(view.filters, disabled)),
      new ActionRowBuilder().addComponents(buildSourceSelect(view.filters, disabled)),
      new ActionRowBuilder().addComponents(buildResultSelect(view.filters, disabled)),
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
      time: HISTORY_TIMEOUT_MS,
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
        console.log(`[ERROR] /樂透 歷史 互動處理失敗:${err}`.red);
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
    console.log(`[ERROR] /樂透 歷史:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 查詢失敗。").catch(() => {});
  }
}

// ───────────────────────────── /樂透 訂閱 開啟 ─────────────────────────────
async function runSubscribe(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!coinSystem?.enabled) {
      return interaction.editReply("🔧 金幣系統尚未啟動!");
    }
    if (!client.lotterySubscriptionsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動。");
    }

    const lcfg = casino?.lottery;
    if (!lcfg?.enabled) {
      return interaction.editReply("🔧 樂透暫時關閉中!");
    }

    const lotteryType = interaction.options.getString("玩法");
    const typeCfg = getTypeConfig(lotteryType);
    if (!typeCfg.enabled) {
      return interaction.editReply("🔧 該玩法暫時關閉!");
    }

    const cfg = getLotteryConfig(lotteryType);
    const subCfg = getSubConfig();
    const totalDraws = interaction.options.getInteger("期數");
    const ticketsPerDraw = interaction.options.getInteger("每期張數") || 1;
    const numbersInput = interaction.options.getString("號碼");

    const maxDraws = subCfg.maxDrawsPerSubscription || 12;
    const ticketBonus =
      twitchPerks.resolvePerks(interaction.member)?.lotteryTicketBonus || 0;
    const maxTickets = (subCfg.maxTicketsPerDraw || 10) + ticketBonus;
    if (totalDraws > maxDraws) {
      return interaction.editReply(`❌ 期數最多 ${maxDraws}`);
    }
    if (ticketsPerDraw > maxTickets) {
      return interaction.editReply(`❌ 每期張數最多 ${maxTickets}`);
    }

    let numbers;
    if (numbersInput && numbersInput.trim()) {
      const v = validateNumbers(numbersInput, lotteryType);
      if (!v.ok) return interaction.editReply(`❌ ${v.error}`);
      numbers = v.numbers;
    } else {
      numbers = pickRandomNumbers(cfg.pickCount, cfg.range);
    }

    const ticketPrice = typeCfg.ticketPrice || 0;
    const costPerDraw = ticketPrice * ticketsPerDraw;

    const subscriptionId = crypto.randomUUID();
    await client.lotterySubscriptionsCollection.insertOne({
      subscriptionId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      username: interaction.member?.displayName || interaction.user.username,
      lotteryType,
      numbers,
      ticketsPerDraw,
      totalDraws,
      drawsRemaining: totalDraws,
      status: "active",
      consecutiveFailures: 0,
      nextDrawId: null,
      lastChargedDrawId: null,
      totalTicketsBought: 0,
      totalSpent: 0,
      totalWon: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await interaction.editReply(
      `${cfg.emoji} **${cfg.label}** 訂閱建立!\n` +
        `號碼:${numbers.join(" ・ ")}\n` +
        `期數:${totalDraws} 期 × 每期 ${ticketsPerDraw} 張\n` +
        `每期扣款:${costPerDraw.toLocaleString()} credits(開獎前 30 分鐘)\n` +
        `預期總支出:${(costPerDraw * totalDraws).toLocaleString()} credits\n\n` +
        `用 \`/樂透 訂閱 列表\` 查看 / 取消。`
    );
  } catch (err) {
    console.log(`[ERROR] /樂透 訂閱 開啟:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 訂閱建立失敗。").catch(() => {});
  }
}

// ───────────────────────────── /樂透 訂閱 列表 ─────────────────────────────
async function runSubscriptions(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.lotterySubscriptionsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動。");
    }
    const subs = await client.lotterySubscriptionsCollection
      .find({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        status: { $in: ["active", "insufficient"] },
      })
      .sort({ createdAt: -1 })
      .toArray();

    if (subs.length === 0) {
      return interaction.editReply(
        "你目前沒有進行中的樂透訂閱。用 `/樂透 訂閱 開啟` 建立一筆吧!"
      );
    }

    const lines = [];
    const components = [];
    for (const s of subs) {
      const cfg = getLotteryConfig(s.lotteryType);
      const label = cfg?.label || s.lotteryType;
      lines.push(
        `**${label}** ・ 號碼 ${s.numbers.join(" ・ ")}\n` +
          `剩餘 ${s.drawsRemaining}/${s.totalDraws} 期 × ${s.ticketsPerDraw} 張 ・ 已花費 ${(s.totalSpent || 0).toLocaleString()} ・ 已得 ${(s.totalWon || 0).toLocaleString()}`
      );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`lotterysub_cancel_${s.subscriptionId}`)
          .setLabel(`取消 ${label} 訂閱`)
          .setStyle(ButtonStyle.Danger)
      );
      components.push(row);
    }

    await interaction.editReply({
      content: lines.join("\n\n"),
      components: components.slice(0, 5),
    });
  } catch (err) {
    console.log(`[ERROR] /樂透 訂閱 列表:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 查詢失敗。").catch(() => {});
  }
}

// ───────────────────────────── /樂透 訂閱 關閉 ─────────────────────────────
// 一次取消所有進行中的訂閱;先彈出確認按鈕,避免誤觸。
async function runUnsubscribeAll(client, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!client.lotterySubscriptionsCollection) {
      return interaction.editReply("🔧 樂透系統尚未啟動。");
    }
    const filter = {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      status: { $in: ["active", "insufficient"] },
    };
    const count = await client.lotterySubscriptionsCollection.countDocuments(filter);
    if (count === 0) {
      return interaction.editReply("你目前沒有進行中的訂閱可以取消。");
    }

    const confirmId = `lotterysub_cancelall_${interaction.user.id}_${Date.now()}`;
    const message = await interaction.editReply({
      content: `⚠️ 即將取消你目前 **${count}** 筆進行中的樂透訂閱,確定嗎?`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(confirmId)
            .setLabel(`確認取消 ${count} 筆`)
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`${confirmId}_no`)
            .setLabel("我再想想")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    });

    const collector = message.createMessageComponentCollector({
      time: 60 * 1000,
      max: 1,
    });

    collector.on("collect", async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        return btn.reply({
          content: "🚫 這不是你的操作。",
          flags: MessageFlags.Ephemeral,
        });
      }
      try {
        await btn.deferUpdate();
        if (btn.customId.endsWith("_no")) {
          await interaction.editReply({
            content: "已取消操作,訂閱維持不變。",
            components: [],
          });
          return;
        }
        const res = await client.lotterySubscriptionsCollection.updateMany(
          filter,
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancelledBy: "user_bulk",
              updatedAt: new Date(),
            },
          }
        );
        await interaction.editReply({
          content: `✅ 已取消 ${res.modifiedCount} 筆樂透訂閱。`,
          components: [],
        });
      } catch (e) {
        console.log(`[ERROR] /樂透 訂閱 關閉 confirm:\n${e}\n${e.stack}`.red);
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        try {
          await interaction.editReply({
            content: "⌛ 超時未確認,訂閱維持不變。",
            components: [],
          });
        } catch {
          /* 忽略 */
        }
      }
    });
  } catch (err) {
    console.log(`[ERROR] /樂透 訂閱 關閉:\n${err}\n${err.stack}`.red);
    await interaction.editReply("🔧 取消失敗。").catch(() => {});
  }
}
