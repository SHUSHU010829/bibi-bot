// /樂透包牌 — 一次選 7-N 個號碼,自動展開所有 6 號組合。

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  getLotteryConfig,
  validateWheelingNumbers,
} = require("../../features/casino/lottery/numbers");
const { calculateWheelingCost, expandWheel } = require("../../features/casino/lottery/wheeling");
const {
  getCurrentOpenDraw,
  ensureNextDraw,
} = require("../../features/casino/lottery/runDraw");
const {
  checkAndAnnouncePoolMilestones,
} = require("../../features/casino/lottery/poolAnnouncer");

function getTypeConfig(t) {
  return casino?.lottery?.types?.[t] || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("樂透包牌")
    .setDescription("包牌:選 7-N 個號碼自動展開所有組合 🎯")
    .setContexts(InteractionContextType.Guild)
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
    .toJSON(),

  run: async (client, interaction) => {
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

      // 確保 open draw
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

      // 扣款
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

      // 展開組合
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
      console.log(`[ERROR] /樂透包牌:\n${err}\n${err.stack}`.red);
      await interaction
        .editReply("🔧 包牌執行失敗,請呼叫舒舒!")
        .catch(() => {});
    }
  },
};
