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
const { newGame } = require("../../features/casino/keno/engine");
const { renderMessage } = require("../../features/casino/keno/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getKenoConfig() {
  return casino?.keno || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("尋寶")
    .setDescription("挑 5 格找寶藏！全中 400 倍 💎")
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
        !client.kenoGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getKenoConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 尋寶暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const paytable = Array.isArray(cfg.paytable) ? cfg.paytable : undefined;

      const rawBet = interaction.options.getString("下注");

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局 selecting
      const existing = await client.kenoGamesCollection.findOne({
        userId,
        guildId,
        status: "selecting",
      });
      if (existing) {
        return interaction.editReply(
          "🗺️ 你還有一張尋寶圖沒收尾！先把上一局打完再開新局。"
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

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "keno", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const initial = newGame({ bet, paytable });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        bet: initial.bet,
        status: initial.status,
        boardSize: initial.boardSize,
        pickCount: initial.pickCount,
        treasureCount: initial.treasureCount,
        treasures: initial.treasures,
        picks: initial.picks,
        paytable: initial.paytable,
        hitCount: initial.hitCount,
        multiplier: initial.multiplier,
        payout: initial.payout,
        result: initial.result,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.kenoGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "keno",
        payload: { options: { 下注: bet } },
      });

      const payload = renderMessage(doc, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /尋寶:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 尋寶執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
