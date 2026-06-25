require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { play } = require("../../features/casino/plinko/engine");
const { renderMessage, RISK_LABEL } = require("../../features/casino/plinko/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getPlinkoConfig() {
  return casino?.plinko || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("彈珠台")
    .setDescription("彈珠從頂端落下，彈進哪格就乘哪格倍率 🔵")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getPlinkoConfig().minBet ?? 10)
    )
    .addStringOption((opt) =>
      opt
        .setName("風險")
        .setDescription("風險越高，邊緣倍率越誇張、中央越容易賠")
        .setRequired(false)
        .addChoices(
          { name: "低風險", value: "low" },
          { name: "中風險", value: "medium" },
          { name: "高風險", value: "high" }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName("排數")
        .setDescription("釘板排數（越多排，倍率分布越極端）")
        .setRequired(false)
        .addChoices(
          { name: "8 排", value: 8 },
          { name: "12 排", value: 12 },
          { name: "16 排", value: 16 }
        )
    )
    .addBooleanOption((opt) =>
      opt
        .setName("梭哈")
        .setDescription("一次押上目前全部餘額")
        .setRequired(false)
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getPlinkoConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 彈珠台暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 0;
      const multipliers = cfg.multipliers;
      const defaultRisk = cfg.defaultRisk ?? "medium";
      const defaultRows = cfg.defaultRows ?? 12;

      const risk = interaction.options.getString("風險") || defaultRisk;
      const rows = interaction.options.getInteger("排數") || defaultRows;

      if (!RISK_LABEL[risk] || !multipliers?.[risk]?.[String(rows)]) {
        return interaction.editReply(
          "這個風險 / 排數組合暫不開放，請換一組再試。"
        );
      }

      const betInput = interaction.options.getInteger("下注");
      const allIn = interaction.options.getBoolean("梭哈") === true;
      if (!allIn && (!Number.isInteger(betInput) || betInput < minBet)) {
        return interaction.editReply(
          `下注金額至少需 ${minBet.toLocaleString()} credits（或勾選梭哈）。`
        );
      }

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;
      const bet = allIn ? balance : betInput;

      if (allIn && balance < minBet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足以梭哈！目前 **${balance.toLocaleString()}** credits，至少需 ${minBet.toLocaleString()}。`
        );
      }
      if (maxBet > 0 && bet > maxBet) {
        return interaction.editReply(
          `下注金額上限 **${maxBet.toLocaleString()}** credits。`
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "plinko", risk, rows },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const result = play({ bet, risk, rows, multipliers });

      if (result.payout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          amount: result.payout,
          source: "payout",
          member,
          meta: {
            game: "plinko",
            risk,
            rows,
            bucket: result.bucket,
            multiplier: result.multiplier,
            bet,
          },
        });
        balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter + result.payout;
      }

      await saveLastBet(client, {
        userId,
        guildId,
        game: "plinko",
        payload: { options: { 下注: bet, 風險: risk, 排數: rows, 梭哈: false } },
      });

      const payload = await renderMessage(result, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /彈珠台:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 彈珠台執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
