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
  // 啟動補開獎時頻道可能還沒進 cache,fetch 回來保底。
  const channel =
    client.channels.cache.get(channelId) ||
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel) {
    console.log(`[LOTTERY] 找不到公告頻道 ${channelId}`.red);
    return;
  }

  const draw = drawResult.draw;
  const tickets = drawResult.tickets || [];
  // quantity 聚合後 tickets 是「doc」數，總張數要累加 quantity（優先用 draw 統計）
  const totalTicketLines =
    draw.totalTickets ?? tickets.reduce((s, t) => s + (t.quantity || 1), 0);
  const lotteryCfg = getLotteryConfig(draw.lotteryType);
  const label = lotteryCfg?.label || draw.lotteryType;
  const emoji = lotteryCfg?.emoji || "🎟";

  const drawnAtLabel = DateTime.fromJSDate(draw.drawnAt || new Date())
    .setZone(TZ)
    .toFormat("yyyy/MM/dd HH:mm");

  const jackpotIds = draw.payout?.jackpot?.ticketIds || [];
  // tickets 可能上萬筆，用 Map 查表（逐筆 .find() 是 O(票數 × 中獎數)）
  const ticketById = new Map(tickets.map((t) => [t.ticketId, t]));
  const jackpotTickets = jackpotIds.map((tid) => ticketById.get(tid)).filter(Boolean);
  const jackpotWinners = [
    ...new Set(
      jackpotTickets.map(
        (t) => t.username || `User-${String(t.userId || "").slice(-4)}`
      )
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
    totalTickets: totalTicketLines,
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
  // 同一位玩家可能有多張頭獎票（不同號碼各一筆 doc），合併成一封 DM
  const dmByUser = new Map();
  for (const t of jackpotTickets) {
    let d = dmByUser.get(t.userId);
    if (!d) {
      d = { userId: t.userId, tickets: 0, comboCount: 0, combos: [] };
      dmByUser.set(t.userId, d);
    }
    d.tickets += t.quantity || 1;
    d.comboCount += 1;
    if (d.combos.length < 5) d.combos.push(t.numbers.join(" ・ "));
  }
  const perWinner = draw.payout?.jackpot?.perWinner || 0;
  for (const d of dmByUser.values()) {
    try {
      const user = await client.users.fetch(d.userId).catch(() => null);
      if (!user) continue;
      const totalWon = perWinner * d.tickets;
      const qtyNote =
        d.tickets > 1 ? `（${d.tickets} 張 × ${perWinner.toLocaleString()}）` : "";
      const comboLine =
        d.combos.map((c) => `**${c}**`).join("、") +
        (d.comboCount > d.combos.length ? `…等 ${d.comboCount} 組` : "");
      await user.send(
        `🎉 ${label} 第 ${draw.drawNumber} 期 你的票 ${comboLine} 中了頭獎!\n` +
        `獎金:**${totalWon.toLocaleString()}** credits${qtyNote} 已入帳。`
      ).catch(() => {});
    } catch (err) {
      console.log(`[LOTTERY] 頭獎 DM 失敗 ${d.userId}:${err.message}`.yellow);
    }
  }

  console.log(`[LOTTERY] 開獎公告已發 ${draw.drawId}`.cyan);
}

module.exports = { announceDrawResult };
