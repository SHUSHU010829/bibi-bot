require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const parseBetAmount = require("../../utils/parseBetAmount");
const { spin, DEFAULT_SEGMENTS } = require("../../features/casino/roulette/multiplierWheel");
const { saveLastBet, buildReplayRow } = require("../../features/casino/replay");
const { buildCasinoContainer } = require("../../features/casino/casinoEmbed");
const generateMultiplierWheelGif = require("../../utils/generateMultiplierWheelGif");

function getCfg() {
  return casino?.multiplierWheel || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("倍率輪盤")
    .setDescription("🎡 倍率輪盤！押 ×2 / ×5 / ×10，轉到自己押的倍率才中獎，中間一堆 0 要閃過")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((opt) =>
      opt
        .setName("押注")
        .setDescription("選一個倍率，轉到它才中獎")
        .setRequired(true)
        .addChoices(
          { name: "×2", value: "2" },
          { name: "×5", value: "5" },
          { name: "×10", value: "10" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("金額")
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
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getCfg();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 倍率轉盤暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const segments = Array.isArray(cfg.segments) && cfg.segments.length
        ? cfg.segments
        : DEFAULT_SEGMENTS;

      const choice = Number(interaction.options.getString("押注"));
      if (![2, 5, 10].includes(choice)) {
        return interaction.editReply("押注倍率只能是 ×2 / ×5 / ×10。");
      }

      const rawBet = interaction.options.getString("金額");

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

      const roundId = crypto.randomUUID();

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "roulette", roundId, choice },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const outcome = spin({ bet, choice, segments });

      // 餘額用算術先算好（bet 已扣、payout 是純加項），GIF 就能與派彩／存檔的 DB 寫入並行，
      // 不必等派彩 doc 回來才開始編碼（比照拉霸）。
      if (outcome.payout > 0) balanceAfter += outcome.payout;

      const net = outcome.net;
      const landedLabel = outcome.landedMult === 0 ? "0" : `×${outcome.landedMult}`;

      let headline;
      if (outcome.payout > 0) {
        headline = `🎡 轉到 **×${choice}**！押中啦 → 派彩 **+${outcome.payout.toLocaleString()}** credits`;
      } else {
        headline = `🎡 押 ×${choice}，卻停在 **${landedLabel}**，這把槓龜了，下次再轉！`;
      }

      const lines = [];
      if (balanceAfter <= 0) {
        lines.push("🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！");
      }

      const embedOutcome = net > 0 ? "win" : net < 0 ? "lose" : "neutral";

      const payoutPromise =
        outcome.payout > 0
          ? grantCoins(client, {
              userId,
              guildId,
              username,
              avatarHash: interaction.user.avatar,
              amount: outcome.payout,
              source: "payout",
              member,
              meta: {
                game: "multiplierWheel",
                roundId,
                choice,
                landedMult: outcome.landedMult,
                payout: outcome.payout,
              },
            }).catch((e) => {
              console.log(`[ERROR] 倍率轉盤 payout 失敗: ${e}`.red);
              return null;
            })
          : Promise.resolve(null);

      const savePromise = saveLastBet(client, {
        userId,
        guildId,
        game: "multiplierWheel",
        payload: { options: { 金額: bet, 押注: String(choice) } },
      }).catch(() => null);

      const gifPromise = generateMultiplierWheelGif({
        segments,
        winningIndex: outcome.winningIndex,
        choice,
        bet,
        payout: outcome.payout,
        username,
        balance: balanceAfter,
      })
        .then((buf) =>
          buf ? new AttachmentBuilder(buf, { name: `multiplierwheel-${roundId}.gif` }) : null
        )
        .catch((gifErr) => {
          console.log(
            `[WARN] 倍率轉盤 gif render failed, falling back to text: ${gifErr.message}`.yellow
          );
          return null;
        });

      const [, , attachment] = await Promise.all([
        payoutPromise,
        savePromise,
        gifPromise,
      ]);

      const container = buildCasinoContainer({
        game: "🎡 倍率轉盤",
        user: { id: interaction.user.id, displayName: username },
        outcome: embedOutcome,
        headline,
        lines,
        bet,
        net,
        balance: balanceAfter,
        imageName: attachment?.name,
        actionRow: buildReplayRow("multiplierWheel", userId, { name: username }),
      });

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        files: attachment ? [attachment] : [],
      });
    } catch (error) {
      console.log(`[ERROR] /輪盤:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 倍率轉盤執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
