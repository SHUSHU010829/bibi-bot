// 開獎公告 + 結果圖卡發送。

require("colors");
const { AttachmentBuilder } = require("discord.js");
const { DateTime } = require("luxon");

const { casino } = require("../../../config");
const generateLotteryResultCard = require("../../../utils/generateLotteryResultCard");
const { getLotteryConfig } = require("./numbers");

const TZ = "Asia/Taipei";

async function announceDrawResult(client, drawResult, options = {}) {
  const { skipWinnerDm = false } = options;
  const cfg = casino?.lottery || {};
  const channelId = cfg.announceChannelId;
  if (!channelId) {
    console.log(`[LOTTERY] 無 announceChannelId,跳過公告`.yellow);
    return;
  }
  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.log(`[LOTTERY] 找不到公告頻道 ${channelId}`.red);
    return;
  }

  const draw = drawResult.draw;
  const tickets = drawResult.tickets || [];
  const lotteryCfg = getLotteryConfig(draw.lotteryType);
  const label = lotteryCfg?.label || draw.lotteryType;
  const emoji = lotteryCfg?.emoji || "🎟";

  const drawnAtLabel = DateTime.fromJSDate(draw.drawnAt || new Date())
    .setZone(TZ)
    .toFormat("yyyy/MM/dd HH:mm");

  const jackpotIds = draw.payout?.jackpot?.ticketIds || [];
  const jackpotWinners = [
    ...new Set(
      jackpotIds
        .map((tid) => tickets.find((t) => t.ticketId === tid))
        .filter(Boolean)
        .map((t) => t.username || `User-${String(t.userId || "").slice(-4)}`)
    ),
  ];

  const buf = await generateLotteryResultCard({
    lotteryType: draw.lotteryType,
    drawId: draw.drawId,
    drawNumber: draw.drawNumber,
    drawnAtLabel,
    winningNumbers: draw.winningNumbers,
    specialNumber: draw.specialNumber,
    pool: draw.pool,
    payout: draw.payout,
    totalTickets: tickets.length,
    jackpotWinners,
  });

  const attachment = new AttachmentBuilder(buf, {
    name: `lottery-${draw.drawId}.png`,
  });

  const winnerLine = (() => {
    const j = draw.payout?.jackpot;
    if (j && j.winnerCount > 0) {
      return `🎉 頭獎中獎 **${j.winnerCount}** 位 ・ 每人 **${j.perWinner.toLocaleString()}** credits`;
    }
    return `🥶 頭獎從缺,彩池滾入下一期`;
  })();

  const rolloverLine = draw.payout?.rolledOver?.amount
    ? `\n滾入下期:**${draw.payout.rolledOver.amount.toLocaleString()}** credits`
    : "";

  const specialZoneLine =
    draw.specialNumber != null ? `\n第二區:**${draw.specialNumber}**` : "";

  const bonus = draw.payout?.bonus;
  const bonusBallLine =
    draw.bonusBall != null
      ? `\n🎯 加碼球:**${draw.bonusBall}**` +
        (bonus?.bonusBallWinners > 0
          ? `（${bonus.bonusBallWinners} 張命中,每張 +${(bonus.bonusBallPrize || 0).toLocaleString()}）`
          : "（無人命中）")
      : "";
  const consecutiveLine =
    bonus?.consecutiveWinners > 0
      ? `\n🔗 連號加碼:**${bonus.consecutiveWinners}** 張中獎號碼含連號,每張 +${(bonus.consecutivePrize || 0).toLocaleString()}`
      : "";

  await channel.send({
    content:
      `# ${emoji} ${label} 第 ${draw.drawNumber} 期 開獎\n` +
      `中獎號碼:**${draw.winningNumbers.join(" ・ ")}**${specialZoneLine}\n` +
      `${winnerLine}${rolloverLine}${bonusBallLine}${consecutiveLine}\n\n` +
      `查詢個人結果:\`/彩券 歷史\``,
    files: [attachment],
  });

  // DM 通知頭獎得主(補發時略過,避免重複私訊)
  if (skipWinnerDm) {
    console.log(`[LOTTERY] 開獎公告已重發 ${draw.drawId}(略過得主 DM)`.cyan);
    return;
  }
  for (const tid of jackpotIds) {
    const t = tickets.find((x) => x.ticketId === tid);
    if (!t) continue;
    try {
      const user = await client.users.fetch(t.userId).catch(() => null);
      if (!user) continue;
      await user.send(
        `🎉 ${label} 第 ${draw.drawNumber} 期 你的票 **${t.numbers.join(" ・ ")}** 中了頭獎!\n` +
        `獎金:**${draw.payout.jackpot.perWinner.toLocaleString()}** credits 已入帳。`
      ).catch(() => {});
    } catch (err) {
      console.log(`[LOTTERY] 頭獎 DM 失敗 ${t.userId}:${err.message}`.yellow);
    }
  }

  console.log(`[LOTTERY] 開獎公告已發 ${draw.drawId}`.cyan);
}

module.exports = { announceDrawResult };
