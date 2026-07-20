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
const { startGame } = require("../../features/casino/mines/engine");
const { renderMessage } = require("../../features/casino/mines/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getMinesConfig() {
  return casino?.mines || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("踩地雷")
    .setDescription("逐格翻開避開地雷，倍率越翻越高，隨時可收手 💣")
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
        !client.minesGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getMinesConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 踩地雷暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const cols = cfg.cols ?? 5;
      const rows = cfg.rows ?? 4;
      const n = cols * rows;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const houseEdge = cfg.houseEdge ?? 0.02;
      const defaultMines = cfg.defaultMines ?? 3;

      const rawBet = interaction.options.getString("下注");
      // 雷數固定為設定值（中等風險），不開放玩家自選。
      const mines = Math.max(1, Math.min(n - 1, defaultMines));

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const existing = await client.minesGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "💣 你還有一盤地雷沒收尾！先把上一局打完再開新局。"
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
        meta: { game: "mines", gameId, mines },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const initial = startGame({ bet, mines, cols, rows, houseEdge });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        bet: initial.bet,
        status: initial.status,
        cols: initial.cols,
        rows: initial.rows,
        n: initial.n,
        mines: initial.mines,
        mineSet: initial.mineSet,
        revealed: initial.revealed,
        hitTile: initial.hitTile,
        multiplier: initial.multiplier,
        houseEdge: initial.houseEdge,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.minesGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "mines",
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
      console.log(`[ERROR] /踩地雷:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 踩地雷執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
