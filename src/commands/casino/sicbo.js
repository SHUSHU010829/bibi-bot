require("colors");
const crypto = require("crypto");
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
} = require("discord.js");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const { rollThree } = require("../../features/casino/sicbo/dice");
const { settleRound } = require("../../features/casino/sicbo/engine");
const {
  isValidBet,
  describeBet,
  NEEDS_VALUE,
} = require("../../features/casino/sicbo/paytable");
const generateSicboCard = require("../../utils/generateSicboCard");

const BET_CHOICES = [
  { name: "大 (11-17)", value: "big" },
  { name: "小 (4-10)", value: "small" },
  { name: "任意圍骰 (三同)", value: "triple_any" },
  { name: "對子 (兩同)", value: "double" },
  { name: "圍骰 (指定三同)", value: "triple_specific" },
  { name: "單骰 (押點數)", value: "single" },
  { name: "總點數", value: "total" },
];

const MAX_BETS = 3;

function buildBetOptionGroup(builder, idx) {
  const required = false;
  const suffix = idx === 1 ? "" : String(idx);
  builder
    .addStringOption((opt) =>
      opt
        .setName(`押法${suffix}`)
        .setDescription(idx === 1 ? "選擇下注類型（梭哈時必填）" : `第 ${idx} 注的押法（選填）`)
        .setRequired(required)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption((opt) =>
      opt
        .setName(`金額${suffix}`)
        .setDescription(idx === 1 ? "下注 credits（勾選梭哈時可省略）" : `第 ${idx} 注的金額`)
        .setRequired(required)
        .setMinValue(casino?.sicbo?.minBet ?? 10)
    )
    .addIntegerOption((opt) =>
      opt
        .setName(`數值${suffix}`)
        .setDescription("單骰/對子/圍骰需要 1-6；總點數需要 4-17")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(17)
    );
  return builder;
}

const builder = new SlashCommandBuilder()
  .setName("骰寶")
  .setDescription("擲三顆骰子賭運氣 🎲（最多同時押 3 注）")
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

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) {
        return interaction.editReply("🔧 金幣系統尚未啟動！");
      }
      if (!client.userCoinsCollection || !client.coinTransactionsCollection) {
        return interaction.editReply("🔧 金幣系統尚未啟動，請聯絡舒舒！");
      }

      const allIn = interaction.options.getBoolean("梭哈") === true;
      const minBet = casino?.sicbo?.minBet ?? 10;
      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;

      // 解析 1~3 注
      const bets = [];
      for (let i = 1; i <= MAX_BETS; i += 1) {
        const suffix = i === 1 ? "" : String(i);
        const type = interaction.options.getString(`押法${suffix}`);
        const amountInput = interaction.options.getInteger(`金額${suffix}`);
        const valueRaw = interaction.options.getInteger(`數值${suffix}`);
        if (!type) continue;
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
        const needsValue = NEEDS_VALUE.includes(type);
        if (needsValue && valueRaw === null) {
          return interaction.editReply(
            `第 ${i} 注：「${describeBet(type, null)}」需要指定**數值**參數。`
          );
        }
        const value = needsValue ? valueRaw : null;
        if (!isValidBet(type, value)) {
          if (type === "single" || type === "double" || type === "triple_specific") {
            return interaction.editReply(
              `第 ${i} 注：「${describeBet(type, null)}」的**數值**必須是 1-6。`
            );
          }
          if (type === "total") {
            return interaction.editReply(
              `第 ${i} 注：「總點數」的**數值**必須是 4-17（3、18 與圍骰重複）。`
            );
          }
          return interaction.editReply(`第 ${i} 注：下注參數錯誤。`);
        }
        bets.push({ type, value, amount });
      }

      if (bets.length === 0) {
        return interaction.editReply("至少要押一注！");
      }

      const totalBet = bets.reduce((s, b) => s + b.amount, 0);

      if (balance < totalBet) {
        return interaction.editReply(
          `💰 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${totalBet.toLocaleString()}（${bets.length} 注合計）。`
        );
      }

      const roundId = crypto.randomUUID();

      // 一次扣完所有注
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -totalBet,
        source: "bet",
        member,
        meta: {
          game: "sicbo",
          bets: bets.map((b) => ({ type: b.type, value: b.value, amount: b.amount })),
          roundId,
        },
      });
      if (!betResult) {
        return interaction.editReply("🔧 下注失敗，請稍後再試。");
      }

      // 擲骰、結算
      const dice = rollThree();
      const sum = dice[0] + dice[1] + dice[2];
      const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
      const round = settleRound(bets, dice);

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
            game: "sicbo",
            results: round.results.map((r) => ({
              type: r.bet.type,
              value: r.bet.value,
              amount: r.bet.amount,
              won: r.won,
              payout: r.payout,
              multiplier: r.multiplier,
            })),
            roundId,
          },
        });
        balanceAfter = payoutResult?.doc?.totalCoins ?? balanceAfter + round.totalPayout;
      }

      // 圖卡：以最高賠率那注作主要顯示，其他注列在文字
      const primary = round.results.reduce((best, r) => {
        if (!best) return r;
        if (r.payout > best.payout) return r;
        return best;
      }, null);

      const buf = await generateSicboCard({
        userId,
        username,
        dice,
        sum,
        betLabel: bets.length === 1
          ? describeBet(primary.bet.type, primary.bet.value)
          : `${bets.length} 注合押`,
        betAmount: totalBet,
        won: round.totalPayout > 0,
        isTriple,
        payout: round.totalPayout,
        multiplier: primary?.multiplier ?? 0,
        balance: balanceAfter,
      });

      const attachment = new AttachmentBuilder(buf, {
        name: `sicbo-${roundId}.png`,
      });

      const lines = round.results.map((r, i) => {
        const label = describeBet(r.bet.type, r.bet.value);
        if (r.won) {
          return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）✨ 中 +${r.payout.toLocaleString()}（×${r.multiplier}）`;
        }
        return `・第 ${i + 1} 注 **${label}**（押 ${r.bet.amount.toLocaleString()}）💸 沒中`;
      });

      const headline = round.totalPayout > 0
        ? isTriple && round.totalPayout >= totalBet * 30
          ? `🎉 **圍骰大獎！** ${dice.join("・")} = ${sum}，總派彩 **+${round.totalPayout.toLocaleString()}** credits`
          : `✨ ${dice.join("・")} = ${sum}，總派彩 **+${round.totalPayout.toLocaleString()}** credits`
        : `💸 ${dice.join("・")} = ${sum}，全部沒中，下次加油！`;

      const net = round.totalPayout - totalBet;
      const netLine = `\n📊 淨輸贏：**${net >= 0 ? "+" : ""}${net.toLocaleString()}** credits`;

      const bankruptLine =
        balanceAfter <= 0
          ? `\n🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！`
          : "";

      await interaction.editReply({
        content: `${headline}\n${lines.join("\n")}${netLine}　・餘額：**${balanceAfter.toLocaleString()}**${bankruptLine}`,
        files: [attachment],
      });
    } catch (error) {
      console.log(`[ERROR] /骰寶:\n${error}\n${error.stack}`.red);
      await interaction
        .editReply("🔧 骰寶執行失敗，請呼叫舒舒！")
        .catch(() => {});
    }
  },
};
