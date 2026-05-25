// /樂透訂閱 — 設定未來 N 期自動買同組號碼。

require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");

const { coinSystem, casino } = require("../../config");
const {
  getLotteryConfig,
  validateNumbers,
  pickRandomNumbers,
} = require("../../features/casino/lottery/numbers");

function getSubConfig() {
  return casino?.lottery?.subscription || {};
}
function getTypeConfig(t) {
  return casino?.lottery?.types?.[t] || {};
}

module.exports = {
  ephemeral: true,
  data: new SlashCommandBuilder()
    .setName("樂透訂閱")
    .setDescription("訂閱未來 N 期自動買同組號碼 🔁")
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
    .toJSON(),

  run: async (client, interaction) => {
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
      const maxTickets = subCfg.maxTicketsPerDraw || 10;
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
          `用 \`/樂透訂閱列表\` 查看 / 取消。`
      );
    } catch (err) {
      console.log(`[ERROR] /樂透訂閱:\n${err}\n${err.stack}`.red);
      await interaction
        .editReply("🔧 訂閱建立失敗。")
        .catch(() => {});
    }
  },
};
