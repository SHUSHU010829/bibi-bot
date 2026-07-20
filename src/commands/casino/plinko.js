require("colors");
const {
  SlashCommandBuilder,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const parseBetAmount = require("../../utils/parseBetAmount");
const { play } = require("../../features/casino/plinko/engine");
const { renderMessage, RISK_LABEL } = require("../../features/casino/plinko/renderer");
const { saveLastBet } = require("../../features/casino/replay");

function getPlinkoConfig() {
  return casino?.plinko || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("彈珠台")
    .setDescription("彈珠從頂端落下，彈進哪格就乘哪格倍率 🔵")
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
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const cfg = getPlinkoConfig();
      if (cfg.enabled === false) {
        return interaction.editReply("🔧 彈珠台暫時關閉中！");
      }

      const minBet = cfg.minBet ?? 10;
      const multipliers = cfg.multipliers;
      // 風險 / 排數固定（綁定圖形板面）：中風險、8 排（9 格）。
      const risk = cfg.defaultRisk ?? "medium";
      const rows = cfg.defaultRows ?? 8;

      if (!RISK_LABEL[risk] || !multipliers?.[risk]?.[String(rows)]) {
        return interaction.editReply("🔧 彈珠台板面設定有誤，請聯絡舒舒！");
      }

      const rawBet = interaction.options.getString("下注");

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

      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -bet,
        source: "bet",
        member,
        meta: { game: "plinko", risk, rows },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }
      let balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

      const result = play({ bet, risk, rows, multipliers });

      // 餘額用算術先算好（bet 已扣、payout 是純加項），GIF 就能與派彩／存檔的 DB 寫入並行，
      // 不必等派彩 doc 回來才開始編碼（比照拉霸）。
      if (result.payout > 0) balanceAfter += result.payout;

      const payoutPromise =
        result.payout > 0
          ? grantCoins(client, {
              userId,
              guildId,
              username,
              amount: result.payout,
              source: "payout",
              member,
              meta: {
                game: "plinko",
                risk,
                rows,
                bucket: result.bucket,
                multiplier: result.multiplier,
                bet,
              },
            }).catch((e) => {
              console.log(`[ERROR] 彈珠台 payout 失敗: ${e}`.red);
              return null;
            })
          : Promise.resolve(null);

      const savePromise = saveLastBet(client, {
        userId,
        guildId,
        game: "plinko",
        payload: { options: { 下注: bet } },
      }).catch(() => null);

      const renderPromise = renderMessage(result, {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      });

      const [, , payload] = await Promise.all([
        payoutPromise,
        savePromise,
        renderPromise,
      ]);
      await interaction.editReply(payload);
    } catch (error) {
      console.log(`[ERROR] /彈珠台:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 彈珠台執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
