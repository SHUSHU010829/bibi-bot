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
const { startGame } = require("../../features/casino/casinoHoldem/engine");
const { renderMessage } = require("../../features/casino/casinoHoldem/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getConfig() {
  return casino?.casinoHoldem || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("德州撲克")
    .setDescription("🃏 跟莊家單挑德州撲克（下底注 → 看牌 → 跟注或蓋牌）")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("底注")
        .setDescription("底注金額（跟注需再押 2 倍；梭哈打 all 會保留跟注的 2 倍）")
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
        !client.casinoHoldemGamesCollection
      ) {
        return interaction.editReply("🔧 賭場德州撲克尚未啟動，請聯絡舒舒！");
      }

      const cfg = getConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 賭場德州撲克暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const ttlSec = cfg.gameTtlSeconds ?? 300;

      const rawAnte = interaction.options.getString("底注");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局 playing
      const existing = await client.casinoHoldemGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🃏 你還有一局德州撲克沒收尾！先把上一局打完（跟注或蓋牌）再開新局。"
        );
      }

      const before = await client.userCoinsCollection.findOne({
        userId,
        guildId,
      });
      const balance = before?.totalCoins || 0;

      const parsed = parseBetAmount(rawAnte, balance);
      if (!parsed.ok) {
        return interaction.editReply(`底注格式錯誤：${parsed.reason}`);
      }
      let ante = parsed.amount;
      // 梭哈（all）：留住跟注的 2 倍，底注取 floor(balance/3)。
      if (parsed.mode === "all") {
        ante = Math.floor(balance / 3);
        if (ante < minBet) {
          return interaction.editReply(
            `${MONEY_EMOJI} 餘額不足以梭哈！跟注需保留 3 倍底注，目前 **${balance.toLocaleString()}** credits，至少需 ${(minBet * 3).toLocaleString()}。`
          );
        }
      }
      if (ante < minBet) {
        return interaction.editReply(
          `底注至少需 **${minBet.toLocaleString()}** credits。`
        );
      }

      if (balance < ante) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下底注 ${ante.toLocaleString()}。`
        );
      }

      const gameId = crypto.randomUUID();

      // 扣底注
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -ante,
        source: "bet",
        member,
        meta: { game: "casinoHoldem", gameId, stage: "ante" },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - ante;

      const initial = startGame({ ante });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        ante,
        status: "playing",
        deck: initial.deck,
        player: initial.player,
        dealer: initial.dealer,
        community: initial.community,
        stage: "flop",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };
      await client.casinoHoldemGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "casinoHoldem",
        payload: { options: { 底注: ante } },
      });

      const payload = await renderMessage(doc, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /德州撲克:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 賭場德州撲克執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
