require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { startGame } = require("../../features/casino/hilo/engine");
const { renderMessage } = require("../../features/casino/hilo/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getHiloConfig() {
  return casino?.hilo || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("hilo")
    .setDescription("猜大小！下一張比底牌大、小、還是相同？🎴")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getHiloConfig().minBet ?? 10)
    )
    .addBooleanOption((opt) =>
      opt
        .setName("梭哈")
        .setDescription("一次押上目前全部餘額")
        .setRequired(false)
    )
    .toJSON(),

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (
        !client.userCoinsCollection ||
        !client.coinTransactionsCollection ||
        !client.hiloGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getHiloConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 HI-LO 暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const houseEdge = cfg.houseEdge ?? 0.05;
      const maxRounds = cfg.maxRounds ?? 10;

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

      // 同時只能有一局 playing
      const existing = await client.hiloGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🎴 你還有一局 HI-LO 沒收尾！先把上一局打完再開新局。"
        );
      }

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
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const gameId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "hilo", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const initial = startGame({ bet, houseEdge, maxRounds });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        bet: initial.bet,
        status: initial.status,
        deck: initial.deck,
        baseCard: initial.baseCard,
        history: initial.history,
        accMultiplier: initial.accMultiplier,
        wins: initial.wins,
        houseEdge: initial.houseEdge,
        maxRounds: initial.maxRounds,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.hiloGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "hilo",
        payload: { options: { 下注: bet, 梭哈: false } },
      });

      const payload = await renderMessage(doc, {
        username,
        balance: balanceAfter,
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /hilo:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 HI-LO 執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
