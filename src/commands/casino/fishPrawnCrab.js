require("colors");
const crypto = require("crypto");
const { SlashCommandBuilder, InteractionContextType } = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  SYMBOLS,
  SYMBOL_BY_KEY,
  rollThree,
  symbolLabel,
  settleRound,
} = require("../../features/casino/fishPrawnCrab/engine");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoEmbed } = require("../../features/casino/casinoEmbed");

const BET_CHOICES = SYMBOLS.map((s) => ({
  name: `${s.emoji} ${s.name}`,
  value: s.key,
}));

const MAX_BETS = 3;

function buildBetOptionGroup(builder, idx) {
  const suffix = idx === 1 ? "" : String(idx);
  builder
    .addStringOption((opt) =>
      opt
        .setName(`押法${suffix}`)
        .setDescription(idx === 1 ? "選擇要押的符號（梭哈時必填）" : `第 ${idx} 注押的符號（選填）`)
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption((opt) =>
      opt
        .setName(`金額${suffix}`)
        .setDescription(idx === 1 ? "下注 credits（勾選梭哈時可省略）" : `第 ${idx} 注的金額`)
        .setRequired(false)
        .setMinValue(casino?.fishPrawnCrab?.minBet ?? 10)
    );
  return builder;
}

const builder = new SlashCommandBuilder()
  .setName("魚蝦蟹")
  .setDescription("擲三顆魚蝦蟹骰賭運氣 🦀（最多同時押 3 注）")
  .setContexts(InteractionContextType.Guild);
for (let i = 1; i <= MAX_BETS; i += 1) buildBetOptionGroup(builder, i);
builder.addBooleanOption((opt) =>
  opt
    .setName("梭哈")
    .setDescription("一次押上目前全部餘額（僅適用第 1 注）")
    .setRequired(false)
);

module.exports = {
  data: builder.toJSON(),

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

      const cfg = casino?.fishPrawnCrab || {};
      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 1000;
      const allIn = interaction.options.getBoolean("梭哈") === true;
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;

      const bets = [];
      for (let i = 1; i <= MAX_BETS; i += 1) {
        const suffix = i === 1 ? "" : String(i);
        const symbol = interaction.options.getString(`押法${suffix}`);
        const amountInput = interaction.options.getInteger(`金額${suffix}`);
        if (!symbol) continue;
        if (allIn && i > 1) {
          return interaction.editReply("梭哈時只能押第 1 注，請移除第 2／3 注。");
        }
        let amount = amountInput;
        if (allIn && i === 1) {
          amount = balance;
        }
        if (amount === null || amount === undefined) {
          return interaction.editReply(`第 ${i} 注少了金額！`);
        }
        if (amount < minBet) {
          return interaction.editReply(
            `第 ${i} 注金額至少需 ${minBet.toLocaleString()} credits${allIn ? "（梭哈餘額不足）" : ""}。`
          );
        }
        if (!allIn && amount > maxBet) {
          return interaction.editReply(
            `第 ${i} 注金額最多 ${maxBet.toLocaleString()} credits。`
          );
        }
        if (!SYMBOL_BY_KEY[symbol]) {
          return interaction.editReply(`第 ${i} 注：押法錯誤。`);
        }
        bets.push({ symbol, amount });
      }

      if (bets.length === 0) {
        return interaction.editReply("至少要押一注！");
      }

      const totalBet = bets.reduce((s, b) => s + b.amount, 0);

      if (balance < totalBet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${totalBet.toLocaleString()}（${bets.length} 注合計）。`
        );
      }

      const roundId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -totalBet,
        source: "bet",
        member,
        meta: {
          game: "fishPrawnCrab",
          bets: bets.map((b) => ({ symbol: b.symbol, amount: b.amount })),
          roundId,
        },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }

      const roll = rollThree();
      const round = settleRound(bets, roll);

      let balanceAfter = betResult.doc?.totalCoins ?? balance - totalBet;

      if (round.totalPayout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: round.totalPayout,
          source: "payout",
          member,
          meta: {
            game: "fishPrawnCrab",
            results: round.results.map((r) => ({
              symbol: r.bet.symbol,
              amount: r.bet.amount,
              won: r.won,
              payout: r.payout,
              multiplier: r.multiplier,
              count: r.count,
            })),
            roundId,
          },
        });
        balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter + round.totalPayout;
      }

      const rolledStr = roll.map((k) => symbolLabel(k)).join("・");

      const lines = round.results.map((r, i) => {
        const label = symbolLabel(r.bet.symbol);
        if (r.won) {
          return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）✨ 開出 ${r.count} 顆 +${r.payout.toLocaleString()}（${r.count}:1）`;
        }
        return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）💸 沒中`;
      });

      const headline =
        round.totalPayout > 0
          ? `✨ 開出 ${rolledStr}，總派彩 **+${round.totalPayout.toLocaleString()}** credits`
          : `💸 開出 ${rolledStr}，全部沒中，下次加油！`;

      const net = round.totalPayout - totalBet;

      const bankruptLine =
        balanceAfter <= 0
          ? `🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！`
          : "";

      const replayOptions = { 梭哈: false };
      bets.forEach((b, i) => {
        const suffix = i === 0 ? "" : String(i + 1);
        replayOptions[`押法${suffix}`] = b.symbol;
        replayOptions[`金額${suffix}`] = b.amount;
      });
      await saveLastBet(client, {
        userId,
        guildId,
        game: "fishPrawnCrab",
        payload: { options: replayOptions },
      });

      const outcome = net > 0 ? "win" : net < 0 ? "lose" : "neutral";

      const extraLines = [...lines];
      if (bankruptLine) extraLines.push(bankruptLine);

      const embed = buildCasinoEmbed({
        game: "🦀 魚蝦蟹",
        user: {
          id: interaction.user.id,
          displayName: interaction.member?.displayName || interaction.user.username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome,
        headline,
        lines: extraLines,
        bet: totalBet,
        net,
        balance: balanceAfter,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        components: [buildReplayRow("fishPrawnCrab", userId, { name: username })],
      });
    } catch (error) {
      console.log(`[ERROR] /魚蝦蟹:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 魚蝦蟹執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
