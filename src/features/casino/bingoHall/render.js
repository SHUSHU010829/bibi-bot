// 賓果大廳訊息組裝（純組裝）。改為頻道按鈕驅動：開場貼購買訊息(按鈕選張數)，
// 開獎貼中獎資訊，免指令。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const HEADERS = ["B", "I", "N", "G", "O"];

// 把 5×5 卡片畫成文字格。drawnSet 有給就標記中球（【】），FREE 中央顯示 ⭐。
function renderCardText(card, drawnSet = null) {
  const lines = [`\`${HEADERS.join("  ")}\``];
  for (let r = 0; r < 5; r++) {
    const cells = [];
    for (let c = 0; c < 5; c++) {
      const v = card[r][c];
      if (v === 0) {
        cells.push("⭐");
        continue;
      }
      const s = String(v).padStart(2, "0");
      if (drawnSet && drawnSet.has(v)) cells.push(`【${s}】`);
      else cells.push(` ${s} `);
    }
    lines.push(cells.join(""));
  }
  return lines.join("\n");
}

function countdownTag(scheduledAt) {
  return `<t:${Math.floor(new Date(scheduledAt).getTime() / 1000)}:R>`;
}

// 開場購買訊息（公開、Embed + 單一買卡按鈕，點了跳輸入框填張數）。
function buildBuyMessage(round, { ticketPrice } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xd4a437)
    .setTitle(`🎱 賓果大廳 第 ${round.roundNumber} 場 開賣中！`)
    .setDescription(
      "點下方「買卡」輸入要買幾張即可參與。\n開出 30 球，完成的連線越多分越多，**連線最多者獨得累積頭彩**！中獎會私訊你兌獎圖。"
    )
    .addFields(
      {
        name: "累積頭彩",
        value: `**${(round.jackpotPoolIn || 0).toLocaleString()}** ${MONEY_EMOJI}`,
        inline: true,
      },
      {
        name: "一張",
        value: `**${(ticketPrice || 0).toLocaleString()}** ${MONEY_EMOJI}`,
        inline: true,
      },
      { name: "開球", value: countdownTag(round.scheduledAt), inline: true }
    )
    .setFooter({ text: "時間到自動開球 · 免指令" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bh_buy_${round.roundId}`)
      .setLabel("買卡")
      .setEmoji("🎟️")
      .setStyle(ButtonStyle.Success)
  );
  return { content: "", embeds: [embed], components: [row] };
}

// 開球後把舊購買訊息收掉（移除按鈕）。
function buildClosedMessage(round) {
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`🎱 賓果大廳 第 ${round.roundNumber} 場 已截止開球`)
    .setDescription("開球結果請見下方，新一場已開賣 👇");
  return { content: "", embeds: [embed], components: [] };
}

// 玩家買卡後的 ephemeral 回覆。
function buildBuyReply({ round, cards, cost, balance, totalCardsThisRound }) {
  const preview = cards.length === 1 ? `\n${renderCardText(cards[0].card)}` : "";
  return (
    `🎟️ 已買 **${cards.length}** 張卡（第 ${round.roundNumber} 場）\n` +
    `花費 **${cost.toLocaleString()}** ${MONEY_EMOJI}　餘額 **${balance.toLocaleString()}**\n` +
    `你本場共 **${totalCardsThisRound}** 張　・　開球 ${countdownTag(round.scheduledAt)}${preview}`
  );
}

function buildAnnounce({ round, settle, drawnBalls }) {
  const drawnStr = drawnBalls
    .slice()
    .sort((a, b) => a - b)
    .map((n) => String(n).padStart(2, "0"))
    .join(" ");

  const lineWinnersAll = settle.results
    .filter((r) => r.prize === "lines" && r.payout > 0)
    .sort((a, b) => b.payout - a.payout);
  const lineWinnersShown = lineWinnersAll
    .slice(0, 5)
    .map((r) => `・<@${r.userId}> ${r.lines} 線 ・ **+${r.payout.toLocaleString()}** ${MONEY_EMOJI}`)
    .join("\n");
  const lineRest = lineWinnersAll.length - 5;

  const jp = settle.results.filter((r) => r.prize === "jackpot");
  const fullHouse = jp.some((r) => r.lines >= 12);
  const hasJackpot = jp.length > 0;
  const jackpotLine = hasJackpot
    ? `🏆 **${fullHouse ? "全餐 BINGO！" : "頭彩"}** ${jp.map((r) => `<@${r.userId}>`).join("・")}（${jp[0].lines} 線）獨得累積頭彩 **${jp[0].payout.toLocaleString()}** ${MONEY_EMOJI}`
    : `🎰 本場無人連線，累積頭彩滾至 **${settle.jackpotPoolOut.toLocaleString()}** ${MONEY_EMOJI}，下場見！`;

  const embed = new EmbedBuilder()
    .setColor(hasJackpot ? 0xd4a437 : 0x3d6f6a)
    .setTitle(`🎱 賓果大廳 第 ${round.roundNumber} 場 開球結果`)
    .setDescription(
      `**開球順序**（共 ${drawnBalls.length} 球）\n\`${drawnStr}\`\n\n${jackpotLine}`
    )
    .setFooter({ text: "中獎者已收到私訊兌獎圖 · 新一場已開賣，往上買卡 👆" });

  if (lineWinnersShown) {
    const restNote = lineRest > 0 ? `\n-# 其餘 ${lineRest} 位中獎玩家未顯示。` : "";
    embed.addFields({
      name: "🎯 連線獎",
      value: `${lineWinnersShown}${restNote}`,
    });
  } else if (hasJackpot) {
    embed.addFields({ name: "🎯 連線獎", value: "本場沒有其他連線中獎者。" });
  }

  const mentionIds = Array.from(
    new Set(jp.map((r) => r.userId).concat(lineWinnersAll.map((r) => r.userId)))
  );

  return {
    content: hasJackpot || lineWinnersShown ? "🎉 賓果大廳開獎啦！" : "",
    embeds: [embed],
    allowedMentions: { parse: [], users: mentionIds },
  };
}

function prizeMeta(prize, lines) {
  if (prize === "jackpot") {
    if (lines >= 12) {
      return { label: "🌈 全餐 BINGO", accent: 0xd4a437, isJackpot: true, isFullHouse: true };
    }
    return { label: "🏆 頭彩", accent: 0xd4a437, isJackpot: true, isFullHouse: false };
  }
  return { label: "🎯 連線獎", accent: 0x3d6f6a, isJackpot: false, isFullHouse: false };
}

function buildWinnerDm({ round, result, fileName, channelId }) {
  const meta = prizeMeta(result.prize, result.lines);

  const container = new ContainerBuilder().setAccentColor(meta.accent);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎉 賓果大廳 第 ${round.roundNumber} 場 中獎！\n` +
        `-# ${meta.label} ・ ${result.lines} 線 ・ 兌獎圖已附上`
    )
  );

  container.addSeparatorComponents(new SeparatorBuilder());

  const fullHouseSuffix = meta.isFullHouse ? "（連 12 線達成）" : "";
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `**獎項**　${meta.label}${fullHouseSuffix}\n` +
        `**入帳**　**+${result.payout.toLocaleString()}** ${MONEY_EMOJI}\n` +
        `**場次**　第 ${round.roundNumber} 場 ・ 完成 ${result.lines} 線`
    )
  );

  if (fileName) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${fileName}`)
          .setDescription(`賓果大廳 第 ${round.roundNumber} 場 兌獎圖`)
      )
    );
  }

  container.addSeparatorComponents(new SeparatorBuilder());

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      channelId
        ? `-# 新一場已開賣 → <#${channelId}> 再來一張碰運氣 🎟️`
        : `-# 新一場已開賣，回大廳再來一張 🎟️`
    )
  );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  renderCardText,
  buildBuyMessage,
  buildClosedMessage,
  buildBuyReply,
  buildAnnounce,
  buildWinnerDm,
};
