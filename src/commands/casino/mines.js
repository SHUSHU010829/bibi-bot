require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
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
    .addIntegerOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getMinesConfig().minBet ?? 10)
    )
    .addIntegerOption((opt) => {
      const cfg = getMinesConfig();
      const n = (cfg.cols ?? 5) * (cfg.rows ?? 4);
      return opt
        .setName("地雷數")
        .setDescription(`盤面有幾顆地雷（越多倍率越高，預設 ${cfg.defaultMines ?? 3}）`)
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(n - 1);
    })
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
      const maxBet = cfg.maxBet ?? 0;
      const cols = cfg.cols ?? 5;
      const rows = cfg.rows ?? 4;
      const n = cols * rows;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const houseEdge = cfg.houseEdge ?? 0.02;
      const defaultMines = cfg.defaultMines ?? 3;

      const betInput = interaction.options.getInteger("下注");
      const allIn = interaction.options.getBoolean("梭哈") === true;
      const minesInput = interaction.options.getInteger("地雷數");
      const mines = Math.max(1, Math.min(n - 1, minesInput ?? defaultMines));

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
        payload: { options: { 下注: bet, 地雷數: mines, 梭哈: false } },
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
