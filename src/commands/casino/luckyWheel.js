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
const { spin, DEFAULT_SEGMENTS } = require("../../features/casino/luckyWheel/engine");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoEmbed } = require("../../features/casino/casinoEmbed");
const generateLuckyWheelGif = require("../../utils/generateLuckyWheelGif");

function getConfig() {
  return casino?.luckyWheel || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("幸運轉盤")
    .setDescription("轉一把加權倍率轉盤，停在哪格就照那格倍率派彩 🎡")
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((opt) =>
      opt
        .setName("金額")
        .setDescription("下注 credits（勾選梭哈時可省略）")
        .setRequired(false)
        .setMinValue(getConfig().minBet ?? 10)
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

      const cfg = getConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 幸運轉盤暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const maxBet = cfg.maxBet ?? 5000;
      const segments = Array.isArray(cfg.segments) && cfg.segments.length
        ? cfg.segments
        : DEFAULT_SEGMENTS;

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
      if (!allIn && maxBet > 0 && bet > maxBet) {
        return interaction.editReply(
          `下注上限 **${maxBet.toLocaleString()}** credits。`
        );
      }
      if (allIn && maxBet > 0 && bet > maxBet) {
        bet = maxBet;
      }
      if (balance < bet) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`
        );
      }

      const roundId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "luckyWheel", roundId },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const outcome = spin({ bet, segments });

      if (outcome.payout > 0) {
        const payoutResult = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: outcome.payout,
          source: "payout",
          member,
          meta: {
            game: "luckyWheel",
            roundId,
            mult: outcome.mult,
            payout: outcome.payout,
          },
        });
        balanceAfter =
          payoutResult?.doc?.totalCoins ?? balanceAfter + outcome.payout;
      }

      const seg = outcome.segment;
      const segLabel = `${seg.emoji ? `${seg.emoji} ` : ""}${seg.label}`;
      const net = outcome.net;

      let headline;
      if (outcome.mult >= 50) {
        headline = `👑 **超級大獎！** 轉盤停在 ${segLabel}（×${outcome.mult}）→ 派彩 **+${outcome.payout.toLocaleString()}** credits`;
      } else if (outcome.payout > 0) {
        headline = `🎡 轉盤停在 ${segLabel}（×${outcome.mult}）→ 派彩 **+${outcome.payout.toLocaleString()}** credits`;
      } else {
        headline = `🎡 轉盤停在 ${segLabel}，這把槓龜了，下次再轉！`;
      }

      const lines = [];
      if (balanceAfter <= 0) {
        lines.push("🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！");
      }

      const result = net > 0 ? "win" : net < 0 ? "lose" : "neutral";
      const embedOutcome = outcome.mult >= 50 ? "jackpot" : result;

      await saveLastBet(client, {
        userId,
        guildId,
        game: "luckyWheel",
        payload: { options: { 金額: bet, 梭哈: false } },
      });

      let attachment = null;
      try {
        const buf = await generateLuckyWheelGif({
          segments,
          winningIndex: outcome.segmentIndex,
          bet,
          payout: outcome.payout,
          mult: outcome.mult,
          label: seg.label,
          username,
          balance: balanceAfter,
        });
        if (buf) {
          attachment = new AttachmentBuilder(buf, {
            name: `luckywheel-${roundId}.gif`,
          });
        }
      } catch (gifErr) {
        console.log(
          `[WARN] 幸運轉盤 gif render failed, falling back to text: ${gifErr.message}`.yellow
        );
      }

      const embed = buildCasinoEmbed({
        game: "🎡 幸運轉盤",
        user: {
          id: interaction.user.id,
          displayName: username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome: embedOutcome,
        headline,
        lines,
        bet,
        net,
        balance: balanceAfter,
        imageName: attachment?.name,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        files: attachment ? [attachment] : [],
        components: [buildReplayRow("luckyWheel", userId, { name: username })],
      });
    } catch (error) {
      console.log(`[ERROR] /幸運轉盤:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 幸運轉盤執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
