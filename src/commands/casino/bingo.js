require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { playRound } = require("../../features/casino/bingo/engine");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoEmbed } = require("../../features/casino/casinoEmbed");

const COLUMN_HEADERS = ["B", "I", "N", "G", "O"];

function getBingoConfig() {
  return casino?.bingo || {};
}

// 把卡片渲染成文字方格：中央 FREE → ⭐；命中 → 【數字】；未中 → 數字。
function renderCardText(card, marks) {
  const lines = [`\`${COLUMN_HEADERS.map((h) => h.padStart(2, " ")).join(" ")}\``];
  for (let r = 0; r < card.length; r++) {
    const cells = [];
    for (let c = 0; c < card[r].length; c++) {
      if (card[r][c] === 0) {
        cells.push("⭐");
      } else if (marks[r][c]) {
        cells.push(`【${String(card[r][c]).padStart(2, "0")}】`);
      } else {
        cells.push(` ${String(card[r][c]).padStart(2, "0")} `);
      }
    }
    lines.push(cells.join(""));
  }
  return lines.join("\n");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("賓果")
    .setDescription("買一張 5×5 賓果卡，開球連線越多賠越多 🎱")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getBingoConfig().minBet ?? 10)
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

      const cfg = getBingoConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 賓果暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 2000;
      const ballsDrawn = cfg.ballsDrawn;
      const linePaytable = Array.isArray(cfg.linePaytable)
        ? cfg.linePaytable
        : undefined;

      const betInput = interaction.options.getInteger("金額");
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
      let bet = allIn ? balance : betInput;

      if (allIn && balance < minBet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足以梭哈！目前 **${balance.toLocaleString()}** credits，至少需 ${minBet.toLocaleString()}。`
        );
      }
      if (maxBet > 0 && bet > maxBet) bet = maxBet;
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
        meta: { game: "bingo", gameId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const round = playRound({ bet, ballsDrawn, linePaytable });

      if (round.payout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: round.payout,
          source: "payout",
          member,
          meta: {
            game: "bingo",
            gameId,
            lines: round.linesCompleted,
            multiplier: round.multiplier,
          },
        });
        balanceAfter =
          payoutResult?.doc?.totalCoins ?? balanceAfter + round.payout;
      }

      await saveLastBet(client, {
        userId,
        guildId,
        game: "bingo",
        payload: { options: { 金額: bet, 梭哈: false } },
      });

      const won = round.payout > 0;
      const headline = won
        ? `🎉 **完成 ${round.linesCompleted} 條連線！** ＋${round.payout.toLocaleString()} credits（×${round.multiplier}）`
        : `💸 **完成 ${round.linesCompleted} 條連線　差一點！**`;

      const cardText = renderCardText(round.card, round.marks);
      const sortedDraw = round.drawn.slice().sort((a, b) => a - b);

      const embed = buildCasinoEmbed({
        game: "🎱 賓果 ・ BINGO",
        user: {
          id: userId,
          displayName: username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome: won ? "win" : "lose",
        headline,
        lines: [
          cardText,
          ``,
          `🎱 開出 **${round.drawn.length}** 顆球：${sortedDraw.join("、")}`,
        ],
        bet,
        net: round.payout - bet,
        balance: balanceAfter,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        components: [buildReplayRow("bingo", userId, { name: username })],
      });
    } catch (error) {
      console.log(`[ERROR] /賓果:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 賓果執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
