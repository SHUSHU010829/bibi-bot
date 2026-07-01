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
const { spinWheel, settle, totalWagered } = require('../../features/casino/roulette/engine');
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
    .setDescription('輪盤 🎰 一次選好押注（可押 1–3 種）與金額，送出直接開轉')
    .setContexts(InteractionContextType.Guild)
    .addStringOption(opt =>
      opt.setName('押注')
        .setDescription('要押的第一個目標')
        .setRequired(true)
        .addChoices(...BET_CHOICES)
    )
    .addIntegerOption(opt =>
      opt.setName('金額')
        .setDescription('投入籌碼總額，會平均分配到每個押注（勾選梭哈時可省略）')
        .setRequired(false)
        .setMinValue(getCfg().minBetPerSlot ?? 30)
    )
    .addStringOption(opt =>
      opt.setName('押注2')
        .setDescription('要押的第二個目標（可選）')
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addStringOption(opt =>
      opt.setName('押注3')
        .setDescription('要押的第三個目標（可選）')
        .setRequired(false)
        .addChoices(...BET_CHOICES)
    )
    .addBooleanOption(opt =>
      opt.setName('梭哈')
        .setDescription('一次押上目前全部餘額')
        .setRequired(false)
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

      // 收集押注（去重，最多 3 種）
      const chosen = [];
      for (const name of ['押注', '押注2', '押注3']) {
        const v = interaction.options.getString(name);
        if (v && BET_TYPES[v] && !chosen.includes(v)) chosen.push(v);
      }
      if (chosen.length === 0) {
        return interaction.editReply('請至少選一個押注目標。');
      }
      const N = chosen.length;

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const username = interaction.member?.displayName || interaction.user.username;
      const member = interaction.member;

      const budgetInput = interaction.options.getInteger('金額');
      const allIn = interaction.options.getBoolean('梭哈') === true;

      if (!allIn && (!Number.isInteger(budgetInput) || budgetInput < minPerSlot)) {
        return interaction.editReply(
          `金額至少 ${minPerSlot.toLocaleString()} credits（或勾選梭哈）。`
        );
      }

      const before = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = before?.totalCoins || 0;

      const total = allIn ? balance : budgetInput;
      const per = Math.floor(total / N);
      if (per < minPerSlot) {
        return interaction.editReply(
          allIn
            ? `${MONEY_EMOJI} 餘額不足以梭哈！押 ${N} 種每種至少 ${minPerSlot.toLocaleString()}，共需 ${(minPerSlot * N).toLocaleString()}，目前僅 ${balance.toLocaleString()}。`
            : `每種押注至少 ${minPerSlot.toLocaleString()} credits，押 ${N} 種至少要投入 ${(minPerSlot * N).toLocaleString()}。`
        );
      }

      const wagered = per * N;
      if (balance < wagered) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，需要 **${wagered.toLocaleString()}**。`
        );
      }

      const bets = chosen.map(type => ({
        type,
        amount: per,
        numbers: BET_TYPES[type].numbers,
      }));

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
        meta: { game: 'roulette', roundId, betCount: N },
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

      const netResult = settlement.totalWin - totalWagered(bets);

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
            押注: chosen[0] ?? null,
            押注2: chosen[1] ?? null,
            押注3: chosen[2] ?? null,
            金額: wagered,
            梭哈: false,
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
