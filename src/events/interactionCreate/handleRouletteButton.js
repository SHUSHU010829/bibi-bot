const {
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../constants/coin");

const grantCoins = require('../../features/economy/grantCoins');
const { BET_TYPES } = require('../../features/casino/roulette/numbers');
const generateRouletteGif = require('../../utils/generateRouletteGif');
const { spinWheel, settle, totalWagered } = require('../../features/casino/roulette/engine');
const { buildBettingRows, buildStatusContent } = require('../../commands/casino/roulette');
const { saveLastBet, buildReplayRow } = require('../../features/casino/replay');
const { buildCasinoEmbed } = require('../../features/casino/casinoEmbed');
const logger = require('../../utils/logger');
const { trackError, trackSuccess } = require('../../utils/errorTracker');
const { consume } = require('../../utils/rateLimiter');

const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function resultEmoji(n) {
  if (n === 0) return '🟢';
  return RED_SET.has(n) ? '🔴' : '⚫';
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;
    if (!id?.startsWith('rl_')) return;
    if (!client.rouletteGamesCollection) return;

    // 解析 customId：
    // rl_outside_<betType>_<gameId>
    // rl_confirm_<gameId>
    // rl_cancel_<gameId>
    const parts = id.split('_');
    const action = parts[1]; // outside / confirm / cancel

    // UUID 不含底線，所以 parts 最後一個一定是 gameId
    const gameId = parts[parts.length - 1];

    // 速率限制：擋連點
    const rl = consume(interaction.user.id, 'btn:roulette', {
      windowMs: 1000,
      max: 1,
    });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    // 先 defer，避免 DB 查詢讓 3 秒 token 過期觸發 10062
    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "roulette-button", gameId, customId: id },
          "互動已逾期,無法 defer"
        );
        trackError("roulette-button", deferErr, { gameId, reason: "expired" });
        return;
      }
      throw deferErr;
    }

    const game = await client.rouletteGamesCollection.findOne({ gameId });
    if (!game) {
      return interaction.followUp({ content: '🎰 找不到這局，可能已逾時。', flags: MessageFlags.Ephemeral });
    }
    if (game.userId !== interaction.user.id) {
      return interaction.followUp({ content: '🚫 這不是你的局！', flags: MessageFlags.Ephemeral });
    }
    if (game.status !== 'betting') {
      return interaction.followUp({ content: '🎰 這局已結束或逾時。', flags: MessageFlags.Ephemeral });
    }

    // ── 押注按鈕 ───────────────────────────────────────────
    if (action === 'outside') {
      // rl_outside_<betType>_<gameId> → betType = parts[2]
      const betType = `outside_${parts[2]}`;
      const def = BET_TYPES[betType];
      if (!def) return interaction.followUp({ content: '❌ 未知押法', flags: MessageFlags.Ephemeral });

      const wagered = totalWagered(game.bets);
      const remaining = game.totalBudget - wagered;
      const amount = Math.floor(remaining / 3);

      if (amount <= 0) {
        return interaction.followUp({ content: `${MONEY_EMOJI} 籌碼不足。`, flags: MessageFlags.Ephemeral });
      }

      const newBet = { type: betType, amount, numbers: def.numbers };
      await client.rouletteGamesCollection.updateOne(
        { _id: game._id, status: 'betting' },
        { $push: { bets: newBet }, $set: { updatedAt: new Date() } }
      );

      const updatedGame = { ...game, bets: [...game.bets, newBet] };
      const newRemaining = remaining - amount;

      await interaction.editReply({
        content: buildStatusContent(updatedGame),
        components: buildBettingRows(gameId, newRemaining),
      });
      return;
    }

    // ── 開轉 ─────────────────────────────────────
    if (action === 'confirm') {
      if (game.bets.length === 0) {
        return interaction.followUp({ content: '❌ 還沒有任何押注！', flags: MessageFlags.Ephemeral });
      }

      const result = spinWheel();
      const settlement = settle(game.bets, result);
      const wagered = totalWagered(game.bets);
      const refund = game.totalBudget - wagered; // 未押完的籌碼退回

      // 派彩 + 退回未押金額
      const payoutTotal = settlement.totalPayout + refund;
      let balanceAfter = (await client.userCoinsCollection.findOne(
        { userId: game.userId, guildId: game.guildId }
      ))?.totalCoins ?? 0;

      if (payoutTotal > 0) {
        const pr = await grantCoins(client, {
          userId: game.userId,
          guildId: game.guildId,
          username: game.username,
          amount: payoutTotal,
          source: 'payout',
          meta: {
            game: 'roulette',
            gameId,
            result,
            betCount: game.bets.length,
            totalWin: settlement.totalWin,
          },
        });
        balanceAfter = pr?.doc?.totalCoins ?? balanceAfter + payoutTotal;
      }

      // 用 status 條件防 race（cron 同時掃不會雙退）
      await client.rouletteGamesCollection.updateOne(
        { _id: game._id, status: 'betting' },
        {
          $set: {
            status: 'settled',
            result,
            totalPayout: payoutTotal,
            totalWin: settlement.totalWin,
            updatedAt: new Date(),
          },
        }
      );

      const winLines = settlement.betResults
        .map(b => {
          const def = BET_TYPES[b.type];
          return b.won
            ? `✅ ${def?.label ?? b.type} +${b.winAmount.toLocaleString()}`
            : `❌ ${def?.label ?? b.type}`;
        })
        .join('\n');

      // 淨輸贏：總贏得 - 已押注（profit，輸為負）
      const netResult = settlement.totalWin - wagered;

      // 生成 GIF（失敗不影響派彩，降級為純文字）
      let gifAttachment = null;
      try {
        const gifBuf = await generateRouletteGif({
          result,
          bets: game.bets,
          settlement,
          username: game.username,
          totalBudget: game.totalBudget,
          balanceAfter,
        });
        gifAttachment = new AttachmentBuilder(gifBuf, { name: 'roulette.gif' });
      } catch (gifErr) {
        logger.warn(
          { source: "roulette-gif", err: gifErr.message },
          "輪盤 GIF 生成失敗,降級為純文字"
        );
        trackError("roulette-gif", gifErr);
      }

      // 紀錄這局的押注分布，供「再來一局」用相同籌碼重開一張下注面板
      await saveLastBet(client, {
        userId: game.userId,
        guildId: game.guildId,
        game: "roulette",
        payload: {
          totalBudget: game.totalBudget,
          bets: game.bets.map((b) => ({
            type: b.type,
            amount: b.amount,
            numbers: b.numbers,
          })),
        },
      });

      // 改用賭場共用 embed：作者放玩家頭像＋名稱，欄位顯示下注／淨輸贏／餘額，遊戲 GIF 放進 embed
      const embed = buildCasinoEmbed({
        game: "🎰 輪盤",
        user: {
          id: game.userId,
          displayName: game.username,
          avatarURL: interaction.user.displayAvatarURL(),
        },
        outcome: netResult > 0 ? "win" : netResult < 0 ? "lose" : "neutral",
        headline: `開出 **${result}** ${resultEmoji(result)}`,
        lines: winLines ? winLines.split("\n") : [],
        bet: wagered,
        net: netResult,
        balance: balanceAfter,
        imageName: gifAttachment ? "roulette.gif" : undefined,
      });

      await interaction.editReply({
        content: "",
        embeds: [embed],
        files: gifAttachment ? [gifAttachment] : [],
        components: [buildReplayRow("roulette", game.userId, { name: game.username })],
      });
      return;
    }

    // ── 取消 ────────────────────────────────────────────────
    if (action === 'cancel') {
      // 用 status 條件防 race（cron 同時掃不會雙退）
      const updated = await client.rouletteGamesCollection.findOneAndUpdate(
        { _id: game._id, status: 'betting' },
        { $set: { status: 'cancelled', updatedAt: new Date() } }
      );
      if (!updated) {
        // 已被 cron 搶先取消
        await interaction.editReply({ content: '🎰 已取消，籌碼退回。', components: [] });
        return;
      }

      await grantCoins(client, {
        userId: game.userId,
        guildId: game.guildId,
        username: game.username,
        amount: game.totalBudget,
        source: 'payout',
        meta: { game: 'roulette', gameId, reason: 'cancelled' },
      });

      await interaction.editReply({ content: '🎰 已取消，籌碼退回。', components: [] });
    }
    trackSuccess("roulette-button");
  } catch (err) {
    logger.error(
      { source: "roulette-button", userId: interaction.user?.id, customId: interaction.customId, err: err.message, stack: err.stack },
      "輪盤按鈕處理失敗"
    );
    trackError("roulette-button", err, { userId: interaction.user?.id, customId: interaction.customId });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '🔧 輪盤按鈕處理失敗，請呼叫舒舒！', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: '🔧 輪盤按鈕處理失敗，請呼叫舒舒！', flags: MessageFlags.Ephemeral });
      }
    } catch (_) { /* noop */ }
  }
};
