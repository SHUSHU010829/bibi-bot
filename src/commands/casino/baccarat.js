require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { deal, settleRound, cardLabel } = require("../../features/casino/baccarat/engine");
const generateBaccaratCard = require("../../utils/generateBaccaratCard");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoEmbed } = require("../../features/casino/casinoEmbed");

const BET_CHOICES = [
  { name: "莊 (1:0.95)", value: "banker" },
  { name: "閒 (1:1)", value: "player" },
  { name: "和 (1:8)", value: "tie" },
  { name: "莊對 (1:11)", value: "banker_pair" },
  { name: "閒對 (1:11)", value: "player_pair" },
];

const BET_LABELS = {
  banker: "莊",
  player: "閒",
  tie: "和",
  banker_pair: "莊對",
  player_pair: "閒對",
};

const MAX_BETS = 3;

function describeBet(type) {
  return BET_LABELS[type] || "未知";
}

function buildBetOptionGroup(builder, idx) {
  const suffix = idx === 1 ? "" : String(idx);
  builder
    .addStringOption((opt) =>
      opt
        .setName(`押法${suffix}`)
        .setDescription(idx === 1 ? "選擇下注類型（第 1 注）" : `第 ${idx} 注的押法（選填）`)
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption((opt) =>
      opt
        .setName(`金額${suffix}`)
        .setDescription(idx === 1 ? "第 1 注的下注 credits" : `第 ${idx} 注的金額`)
        .setRequired(false)
        .setMinValue(casino?.baccarat?.minBet ?? 10)
    );
  return builder;
}

const builder = new SlashCommandBuilder()
  .setName("百家樂")
  .setDescription("莊閒對決，押中拿賠彩 🎴（最多同時押 3 注）")
  .setContexts(InteractionContextType.Guild);
for (let i = 1; i <= MAX_BETS; i += 1) buildBetOptionGroup(builder, i);

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

      const cfg = casino?.baccarat || {};
      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 50000;
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;

      const bets = [];
      for (let i = 1; i <= MAX_BETS; i += 1) {
        const suffix = i === 1 ? "" : String(i);
        const type = interaction.options.getString(`押法${suffix}`);
        const amountInput = interaction.options.getInteger(`金額${suffix}`);
        if (!type) continue;
        const amount = amountInput;
        if (amount === null || amount === undefined) {
          return interaction.editReply(`第 ${i} 注少了金額！`);
        }
        if (amount < minBet) {
          return interaction.editReply(
            `第 ${i} 注金額至少需 ${minBet.toLocaleString()} credits。`
          );
        }
        if (amount > maxBet) {
          return interaction.editReply(
            `第 ${i} 注金額上限為 ${maxBet.toLocaleString()} credits。`
          );
        }
        bets.push({ type, amount });
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
          game: "baccarat",
          bets: bets.map((b) => ({ type: b.type, amount: b.amount })),
          roundId,
        },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }

      const dealResult = deal();
      const round = settleRound(bets, dealResult);

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
            game: "baccarat",
            outcome: dealResult.outcome,
            results: round.results.map((r) => ({
              type: r.bet.type,
              amount: r.bet.amount,
              won: r.won,
              push: r.push,
              payout: r.payout,
              multiplier: r.multiplier,
            })),
            roundId,
          },
        });
        balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter + round.totalPayout;
      }

      const playerCards = dealResult.player.map(cardLabel).join(" ");
      const bankerCards = dealResult.banker.map(cardLabel).join(" ");
      const handLines = [
        `閒 ${playerCards} ＝ ${dealResult.playerTotal}${dealResult.playerPair ? "（對子）" : ""}`,
        `莊 ${bankerCards} ＝ ${dealResult.bankerTotal}${dealResult.bankerPair ? "（對子）" : ""}`,
      ];

      const betLines = round.results.map((r, i) => {
        const label = describeBet(r.bet.type);
        if (r.won) {
          return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）✨ 中 +${r.payout.toLocaleString()}`;
        }
        if (r.push) {
          return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）🤝 和局退回 ${r.payout.toLocaleString()}`;
        }
        return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）💸 沒中`;
      });

      const outcomeText =
        dealResult.outcome === "banker"
          ? "莊家贏"
          : dealResult.outcome === "player"
          ? "閒家贏"
          : "和局";

      const net = round.totalPayout - totalBet;
      const headline =
        round.totalPayout > 0
          ? `🎴 ${outcomeText}！總派彩 **+${round.totalPayout.toLocaleString()}** credits`
          : `💸 ${outcomeText}，全部沒中，下次加油！`;

      const lines = [...handLines, "", ...betLines];
      if (balanceAfter <= 0) {
        lines.push("🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！");
      }

      const replayOptions = {};
      bets.forEach((b, i) => {
        const suffix = i === 0 ? "" : String(i + 1);
        replayOptions[`押法${suffix}`] = b.type;
        replayOptions[`金額${suffix}`] = b.amount;
      });
      await saveLastBet(client, {
        userId,
        guildId,
        game: "baccarat",
        payload: { options: replayOptions },
      });

      const outcome = net > 0 ? "win" : net < 0 ? "lose" : "neutral";

      let attachment = null;
      try {
        const buf = await generateBaccaratCard({
          player: dealResult.player,
          banker: dealResult.banker,
          playerTotal: dealResult.playerTotal,
          bankerTotal: dealResult.bankerTotal,
          outcome: dealResult.outcome,
          playerPair: dealResult.playerPair,
          bankerPair: dealResult.bankerPair,
          betLabel: bets.length === 1
            ? describeBet(bets[0].type)
            : `${bets.length} 注合押`,
          betAmount: totalBet,
          payout: round.totalPayout,
          net,
          balance: balanceAfter,
          username,
        });
        attachment = new AttachmentBuilder(buf, {
          name: `baccarat-${roundId}.png`,
        });
      } catch (cardErr) {
        console.log(
          `[WARN] baccarat card render failed, falling back to text: ${cardErr.message}`.yellow
        );
      }

      const embed = buildCasinoEmbed({
        game: "🎴 百家樂",
        user: {
          id: interaction.user.id,
          displayName: username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome,
        headline,
        lines,
        bet: totalBet,
        net,
        balance: balanceAfter,
        imageName: attachment?.name,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        files: attachment ? [attachment] : [],
        components: [buildReplayRow("baccarat", userId, { name: username })],
      });
    } catch (error) {
      console.log(`[ERROR] /百家樂:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 百家樂執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
