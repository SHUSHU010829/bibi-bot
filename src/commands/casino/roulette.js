require('colors');
const crypto = require('crypto');
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags,
  InteractionContextType,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const { coinSystem, casino } = require('../../config');
const grantCoins = require('../../features/economy/grantCoins');
const { BET_TYPES } = require('../../features/casino/roulette/numbers');
const { totalWagered } = require('../../features/casino/roulette/engine');

function getCfg() {
  return casino?.roulette || {};
}

function unitAmount(remaining) {
  return Math.floor(remaining / 3);
}

function buildBettingRows(gameId, remainingBudget) {
  const disabled = unitAmount(remainingBudget) <= 0;

  const btn = (type, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder()
      .setCustomId(`rl_outside_${type}_${gameId}`)
      .setLabel(label)
      .setStyle(style)
      .setDisabled(disabled);

  const row1 = new ActionRowBuilder().addComponents(
    btn('red',   '🔴 紅', ButtonStyle.Danger),
    btn('black', '⚫ 黑'),
    btn('odd',   '奇'),
    btn('even',  '偶'),
  );
  const row2 = new ActionRowBuilder().addComponents(
    btn('low',  '1–18'),
    btn('high', '19–36'),
    btn('zero', '🟢 0', ButtonStyle.Success),
  );
  const row3 = new ActionRowBuilder().addComponents(
    btn('dozen1', '第一打'),
    btn('dozen2', '第二打'),
    btn('dozen3', '第三打'),
  );
  const row4 = new ActionRowBuilder().addComponents(
    btn('col1', '第一列'),
    btn('col2', '第二列'),
    btn('col3', '第三列'),
    new ButtonBuilder()
      .setCustomId(`rl_confirm_${gameId}`)
      .setLabel('✅ 開轉')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`rl_cancel_${gameId}`)
      .setLabel('❌ 取消')
      .setStyle(ButtonStyle.Danger),
  );

  return [row1, row2, row3, row4];
}

function buildStatusContent(game) {
  const wagered = totalWagered(game.bets);
  const remaining = game.totalBudget - wagered;
  const unit = unitAmount(remaining);

  const betLines = game.bets.length === 0
    ? '_尚未押注_'
    : game.bets.map(b => {
        const def = BET_TYPES[b.type];
        return `・${def?.label ?? b.type} **${b.amount.toLocaleString()}** (x${def?.payout ?? '?'})`;
      }).join('\n');

  return (
    `🎰 **輪盤**　剩 **${remaining.toLocaleString()}** / ${game.totalBudget.toLocaleString()}　每押 **${unit.toLocaleString()}**\n\n` +
    `${betLines}\n\n` +
    `-# 🟢 0 為單一號碼、賠率 35×；開出 0 時紅黑・奇偶・大小・打・列 一律不中\n` +
    `-# 90 秒未開轉自動退款`
  );
}

// 下注面板改用 Components V2：狀態文字 + 分隔線 + 下注按鈕全收進一個容器，
// 與倍率輪盤等賭場結果卡片外觀一致。
function buildBettingContainer(game) {
  const remaining = game.totalBudget - totalWagered(game.bets);
  const container = new ContainerBuilder().setAccentColor(0x5865f2);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(buildStatusContent(game))
  );
  container.addSeparatorComponents(new SeparatorBuilder());
  for (const row of buildBettingRows(game.gameId, remaining)) {
    container.addActionRowComponents(row);
  }
  return container;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('輪盤')
    .setDescription('輪盤 🎰 押紅黑、奇偶、大小、打、列')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption(opt =>
      opt.setName('金額')
        .setDescription('投入籌碼總額（勾選梭哈時可省略）')
        .setRequired(false)
        .setMinValue(getCfg().minBetPerSlot ?? 30)
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
      if (!client.rouletteGamesCollection) return interaction.editReply('🔧 輪盤系統未啟動，請聯絡舒舒！');

      const cfg = getCfg();
      if (cfg.enabled === false) return interaction.editReply('🔧 輪盤暫時關閉中！');

      const userId = interaction.user.id;
      const guildId = interaction.guildId;
      const budgetInput = interaction.options.getInteger('金額');
      const allIn = interaction.options.getBoolean('梭哈') === true;
      const minBudget = cfg.minBetPerSlot ?? 30;
      const timeoutSec = cfg.bettingTimeoutSeconds ?? 90;
      const username = interaction.member?.displayName || interaction.user.username;

      if (!allIn && (!Number.isInteger(budgetInput) || budgetInput < minBudget)) {
        return interaction.editReply(
          `金額至少 ${minBudget.toLocaleString()} credits（或勾選梭哈）`
        );
      }

      // 同時只能有一局 betting 中
      const existing = await client.rouletteGamesCollection.findOne({
        userId, guildId, status: 'betting',
      });
      if (existing) {
        return interaction.editReply('🎰 你還有一局在進行中！');
      }

      // 餘額檢查
      const userDoc = await client.userCoinsCollection.findOne({ userId, guildId });
      const balance = userDoc?.totalCoins || 0;
      const totalBudget = allIn ? balance : budgetInput;
      if (allIn && balance < minBudget) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足以梭哈！目前 **${balance.toLocaleString()}** credits，至少需 ${minBudget.toLocaleString()}。`
        );
      }
      if (balance < totalBudget) {
        return interaction.editReply(
          `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，需要 **${totalBudget.toLocaleString()}**。`
        );
      }

      // 先扣款
      const betResult = await grantCoins(client, {
        userId,
        guildId,
        username,
        avatarHash: interaction.user.avatar,
        amount: -totalBudget,
        source: 'bet',
        member: interaction.member,
        meta: { game: 'roulette' },
      });
      if (!betResult) return interaction.editReply('🔧 扣款失敗，請稍後再試。');

      const gameId = crypto.randomUUID();
      const now = new Date();

      const game = {
        gameId,
        userId,
        guildId,
        username,
        status: 'betting',
        totalBudget,
        bets: [],
        result: null,
        totalPayout: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(now.getTime() + timeoutSec * 1000),
      };

      await client.rouletteGamesCollection.insertOne(game);

      await interaction.editReply({
        flags: MessageFlags.IsComponentsV2,
        components: [buildBettingContainer(game)],
      });
    } catch (err) {
      console.log(`[ERROR] /輪盤:\n${err}\n${err.stack}`.red);
      await interaction.editReply('🔧 輪盤開局失敗，請呼叫舒舒！').catch(() => {});
    }
  },

  // 供 handleRouletteButton.js 使用
  buildBettingRows,
  buildStatusContent,
  buildBettingContainer,
  unitAmount,
};
