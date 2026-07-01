require('colors');
const crypto = require('crypto');
const {
  SlashCommandBuilder,
  AttachmentBuilder,
  InteractionContextType,
  MessageFlags,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require('../../config');
const grantCoins = require('../../features/economy/grantCoins');
const { BET_TYPES } = require('../../features/casino/roulette/numbers');
const { spinWheel, settle } = require('../../features/casino/roulette/engine');
const { saveLastBet, buildReplayRow } = require('../../features/casino/replay');
const { buildCasinoContainer } = require('../../features/casino/casinoEmbed');
const generateRouletteGif = require('../../utils/generateRouletteGif');

// 下拉可選的押注（value = BET_TYPES key，name 為中文顯示）
const BET_CHOICES = [
  { name: '🔴 紅色 (1:1)', value: 'outside_red' },
  { name: '⚫ 黑色 (1:1)', value: 'outside_black' },
  { name: '奇數 (1:1)', value: 'outside_odd' },
  { name: '偶數 (1:1)', value: 'outside_even' },
  { name: '1–18 (1:1)', value: 'outside_low' },
  { name: '19–36 (1:1)', value: 'outside_high' },
  { name: '第一打 1-12 (2:1)', value: 'outside_dozen1' },
  { name: '第二打 13-24 (2:1)', value: 'outside_dozen2' },
  { name: '第三打 25-36 (2:1)', value: 'outside_dozen3' },
  { name: '第一列 (2:1)', value: 'outside_col1' },
  { name: '第二列 (2:1)', value: 'outside_col2' },
  { name: '第三列 (2:1)', value: 'outside_col3' },
  { name: '🟢 0（單一號碼 35:1）', value: 'outside_zero' },
];

const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function resultEmoji(n) {
  if (n === 0) return '🟢';
  return RED_SET.has(n) ? '🔴' : '⚫';
}

function getCfg() {
  return casino?.roulette || {};
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('輪盤')
    .setDescription('輪盤 🎰 一次選好押注（可押 1–3 種）與各自金額，送出直接開轉')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(opt =>
      opt.setName('押注')
        .setDescription('要押的第一個目標')
        .setRequired(true)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption(opt =>
      opt.setName('金額')
        .setDescription('押注 的下注金額')
        .setRequired(true)
        .setMinValue(getCfg().minBetPerSlot ?? 30)
    )
    .addStringOption(opt =>
      opt.setName('押注2')
        .setDescription('要押的第二個目標（可選）')
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption(opt =>
      opt.setName('金額2')
        .setDescription('押注2 的下注金額')
        .setRequired(false)
        .setMinValue(getCfg().minBetPerSlot ?? 30)
    )
    .addStringOption(opt =>
      opt.setName('押注3')
        .setDescription('要押的第三個目標（可選）')
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption(opt =>
      opt.setName('金額3')
        .setDescription('押注3 的下注金額')
        .setRequired(false)
        .setMinValue(getCfg().minBetPerSlot ?? 30)
    )
    .toJSON(),

  subcommandOnly: true,

  run: async (client, interaction) => {
    await interaction.deferReply();

    try {
      if (!coinSystem?.enabled) return interaction.editReply('🔧 金幣系統未啟動');
      if (!client.userCoinsCollection) return interaction.editReply('🔧 金幣系統未啟動，請聯絡舒舒！');

      const cfg = getCfg();
      if (cfg.enabled === false) return interaction.editReply('🔧 輪盤暫時關閉中！');

      const minPerSlot = cfg.minBetPerSlot ?? 30;

      // 收集押注：每個目標各自指定金額，同一目標合併金額
      const betMap = new Map();
      for (const [tName, aName] of [['押注', '金額'], ['押注2', '金額2'], ['押注3', '金額3']]) {
        const type = interaction.options.getString(tName);
        if (!type || !BET_TYPES[type]) continue;
        const amount = interaction.options.getInteger(aName);
        if (!Number.isInteger(amount) || amount < minPerSlot) {
          const def = BET_TYPES[type];
          return interaction.editReply(
            `「${def?.label ?? type}」需要指定金額，且每注至少 ${minPerSlot.toLocaleString()} credits。`
          );
        }
        betMap.set(type, (betMap.get(type) || 0) + amount);
      }
      if (betMap.size === 0) {
        return interaction.editReply('請至少選一個押注目標並填金額。');
      }

      const bets = [...betMap.entries()].map(([type, amount]) => ({
        type,
        amount,
        numbers: BET_TYPES[type].numbers,
      }));
      const wagered = bets.reduce((s, b) => s + b.amount, 0);

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;
      if (balance < wagered) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，需要 **${wagered.toLocaleString()}**。`
        );
      }

      const roundId = crypto.randomUUID();

      // 先扣款
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -wagered,
        source: 'bet',
        member,
        meta: { game: 'roulette', roundId, betCount: bets.length },
      });
      if (!betResult) return interaction.editReply('🔧 扣款失敗，請稍後再試。');
      let balanceAfter = betResult.doc?.totalCoins ?? balance - wagered;

      // 開轉 + 結算
      const result = spinWheel();
      const settlement = settle(bets, result);

      if (settlement.totalPayout > 0) {
        const pr = await grantCoins(client, {
          userId,
          guildId,
          username,
          avatarHash: interaction.user.avatar,
          amount: settlement.totalPayout,
          source: 'payout',
          member,
          meta: {
            game: 'roulette',
            roundId,
            result,
            totalWin: settlement.totalWin,
          },
        });
        balanceAfter = pr?.doc?.totalCoins ?? balanceAfter + settlement.totalPayout;
      }

      const netResult = settlement.totalPayout - wagered;

      const winLines = settlement.betResults.map(b => {
        const def = BET_TYPES[b.type];
        return b.won
          ? `✅ ${def?.label ?? b.type} +${b.winAmount.toLocaleString()}`
          : `❌ ${def?.label ?? b.type}`;
      });

      const extraLines = [];
      if (balanceAfter <= 0) {
        extraLines.push('🚨 **你破產了！** 餘額歸零，去發言、聊天賺金幣再來吧！');
      }

      // 供「再來一局」用相同押注 + 金額重跑
      await saveLastBet(client, {
        userId,
        guildId,
        game: 'roulette',
        payload: {
          options: {
            押注: bets[0]?.type ?? null,
            金額: bets[0]?.amount ?? null,
            押注2: bets[1]?.type ?? null,
            金額2: bets[1]?.amount ?? null,
            押注3: bets[2]?.type ?? null,
            金額3: bets[2]?.amount ?? null,
          },
        },
      });

      // 結果 GIF（失敗不影響派彩，降級為純文字卡片）
      let attachment = null;
      try {
        const buf = await generateRouletteGif({ result });
        if (buf) attachment = new AttachmentBuilder(buf, { name: `roulette-${roundId}.gif` });
      } catch (gifErr) {
        console.log(`[WARN] 輪盤 gif 生成失敗，降級純文字: ${gifErr.message}`.yellow);
      }

      const container = buildCasinoContainer({
        game: '🎰 輪盤',
        user: { id: userId, displayName: username },
        outcome: netResult > 0 ? 'win' : netResult < 0 ? 'lose' : 'neutral',
        headline: `開出 **${result}** ${resultEmoji(result)}`,
        lines: [...winLines, ...extraLines],
        bet: wagered,
        net: netResult,
        balance: balanceAfter,
        imageName: attachment?.name,
        actionRow: buildReplayRow('roulette', userId, { name: username }),
      });

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        files: attachment ? [attachment] : [],
      });
    } catch (err) {
      console.log(`[ERROR] /輪盤:\n${err}\n${err.stack}`.red);
      await interaction.editReply('🔧 輪盤執行失敗，請呼叫舒舒！').catch(() => {});
    }
  },
};
