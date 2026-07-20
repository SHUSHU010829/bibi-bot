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
const { startGame, DIFFICULTIES, DEFAULT_DIFFICULTY } = require("../../features/casino/tower/engine");
const { renderMessage } = require("../../features/casino/tower/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getTowerConfig() {
  return casino?.tower || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("爬塔")
    .setDescription("一層一層往上爬，避開陷阱、倍率越疊越高，隨時可收手 🗼")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("下注")
        .setDescription("下注金額（梭哈打 all，也支援 1.5k、50%）")
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("難度")
        .setDescription("格數越少、陷阱越多 → 每層倍率越高")
        .setRequired(false)
        .addChoices(
          ...Object.values(DIFFICULTIES).map((d) => ({
            name: `${d.label}（${d.tiles} 格 ${d.traps} 雷）`,
            value: d.key,
          }))
        )
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
        !client.towerGamesCollection
      ) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getTowerConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 爬塔暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const ttlSec = cfg.gameTtlSeconds ?? 300;
      const houseEdge = cfg.houseEdge ?? 0.05;
      const maxFloors = cfg.maxFloors ?? 9;

      const rawBet = interaction.options.getString("下注");
      const difficulty =
        interaction.options.getString("難度") || DEFAULT_DIFFICULTY;

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username =
        interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      // 同時只能有一局 playing
      const existing = await client.towerGamesCollection.findOne({
        userId,
        guildId,
        status: "playing",
      });
      if (existing) {
        return interaction.editReply(
          "🗼 你還有一座塔沒爬完！先把上一局收尾再開新局。"
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
        meta: { game: "tower", gameId, difficulty },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const initial = startGame({ bet, difficulty, houseEdge, maxFloors });
      const now = new Date();
      const doc = {
        gameId,
        userId,
        guildId,
        username,
        bet: initial.bet,
        status: initial.status,
        difficulty: initial.difficulty,
        tilesPerFloor: initial.tilesPerFloor,
        trapsPerFloor: initial.trapsPerFloor,
        maxFloors: initial.maxFloors,
        traps: initial.traps,
        currentFloor: initial.currentFloor,
        picks: initial.picks,
        hitTile: initial.hitTile,
        floorMultiplier: initial.floorMultiplier,
        accMultiplier: initial.accMultiplier,
        houseEdge: initial.houseEdge,
        result: initial.result,
        payout: initial.payout,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      };

      await client.towerGamesCollection.insertOne(doc);

      await saveLastBet(client, {
        userId,
        guildId,
        game: "tower",
        payload: { options: { 下注: bet, 難度: difficulty } },
      });

      const payload = await renderMessage(doc, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /爬塔:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 爬塔執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
