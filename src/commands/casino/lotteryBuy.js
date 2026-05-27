// /樂透買 — 手動買票或選號隨機買。

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
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
} = require("../../features/casino/lottery/numbers");
const {
  getCurrentOpenDraw,
  ensureNextDraw,
} = require("../../features/casino/lottery/runDraw");
const {
  checkAndAnnouncePoolMilestones,
} = require("../../features/casino/lottery/poolAnnouncer");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");

function getLotteryFeatureConfig() {
  return casino?.lottery || {};
}

function getTypeConfig(t) {
  return getLotteryFeatureConfig().types?.[t] || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("樂透買")
    .setDescription("買樂透票 🎟")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName("玩法")
        .setDescription("玩法")
        .setRequired(true)
        .addChoices(
          { name: "大樂透 6/49", value: "6_49" },
          { name: "小樂透 3/20", value: "3_20" }
        )
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
    .toJSON(),

  run: async (client, interaction) => {
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

      // 確保有 open draw
      let draw = await getCurrentOpenDraw(client, lotteryType);
      if (!draw) {
        draw = await ensureNextDraw(client, lotteryType);
      }
      if (!draw) {
        return interaction.editReply("🔧 暫時無法取得當期樂透,請稍後再試。");
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 餘額檢查
      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < totalCost) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足!目前 **${balance.toLocaleString()}** credits,需要 ${totalCost.toLocaleString()}。`
        );
      }

      const orderId = crypto.randomUUID();

      // 扣款
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

      // 寫票券
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

      // 更新 draw 統計
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

      // 觸發里程碑
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
      const moreLine = ticketDocs.length > 10 ? `\n…再 ${ticketDocs.length - 10} 張` : "";

      await saveLastBet(client, {
        userId,
        guildId,
        game: "lottery",
        payload: {
          options: {
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
        components: [buildReplayRow("lottery", userId, { label: "🔁 再買一單", name: username })],
      });
    } catch (err) {
      console.log(`[ERROR] /樂透買:\n${err}\n${err.stack}`.red);
      await interaction
        .editReply("🔧 樂透買票執行失敗,請呼叫舒舒!")
        .catch(() => {});
    }
  },
};
