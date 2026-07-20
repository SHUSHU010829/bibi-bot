require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const parseBetAmount = require("../../utils/parseBetAmount");
const { startGame } = require("../../features/casino/blackjack/engine");
const { renderMessage } = require("../../features/casino/blackjack/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getBjConfig() {
  return casino?.blackjack || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("二十一點")
    .setDescription("跟莊家比 21 點 🃏")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注金額（梭哈打 all，也支援 1.5k、50%）")
        .setRequired(true)
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (
        !client.userCoinsCollection ||
        !client.coinTransactionsCollection ||
        !client.blackjackGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getBjConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 21 點暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const ttlSec = cfg.gameTtlSeconds ?? 300;

      const rawBet = interaction.options.getString("下注");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局 playing
      const existing = await client.blackjackGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🃏 你還有一局 21 點沒收尾！先把上一局打完再開新局。"
        );
      }

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;
      const parsed = parseBetAmount(rawBet, balance);
      if (!parsed.ok) {
        return interaction.editReply(`下注格式錯誤：${parsed.reason}`);
      }
      const bet = parsed.amount;
      if (bet < minBet) {
        return interaction.editReply(
          `下注金額至少需 **${minBet.toLocaleString()}** credits。`
        );
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const gameId = crypto.randomUUID();

      // 扣下注
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "blackjack", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      // 開局
      const initial = startGame({ bet });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        bet: initial.bet,
        doubled: initial.doubled,
        status: initial.status,
        deck: initial.deck,
        playerHand: initial.playerHand,
        dealerHand: initial.dealerHand,
        hands: initial.hands,
        activeIndex: initial.activeIndex,
        isSplit: initial.isSplit,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      // 起手就 settled（雙方 BJ / 玩家 BJ / 莊家 BJ）→ 派彩
      if (initial.status === "settled" && initial.payout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: initial.payout,
          source: "payout",
          member,
          meta: {
            game: "blackjack",
            result: initial.result,
            gameId,
            bet,
            doubled: false,
          },
        });
        balanceAfter =
          payoutResult?.doc?.totalCoins ?? balanceAfter + initial.payout;
      }

      // 起手就 settled（雙方 BJ 等）的局，牌型已沒人需要查 → 不存進 doc 省 storage
      const docToInsert = { ...doc };
      if (doc.status === "settled") {
        delete docToInsert.deck;
        delete docToInsert.playerHand;
        delete docToInsert.dealerHand;
        delete docToInsert.hands;
      }
      await client.blackjackGamesCollection.insertOne(docToInsert);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "blackjack",
        payload: { options: { 下注: bet } },
      });

      const payload = await renderMessage(doc, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /二十一點:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 21 點執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
