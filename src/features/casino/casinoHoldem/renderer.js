// 把 Casino Hold'em state 渲染成 Discord 訊息 payload。
// 開局（flop）用 跟注 / 蓋牌 按鈕；結算後用「再來一局」按鈕。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { categoryLabel } = require("../poker/hand");
const { anteOddsMultiplier } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
const { MONEY_EMOJI } = require("../../../constants/coin");

const SUIT_EMOJI = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function formatCard(card) {
  return `${RANK_LABEL[card[0]]}${SUIT_EMOJI[card[1]]}`;
}

function cardsLine(cards) {
  return cards.map((c) => `[ ${formatCard(c)} ]`).join(" ");
}

function buildActionRow(state) {
  const gameId = state.gameId;
  const callBet = state.ante * 2;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ch_call_${gameId}`)
      .setLabel(`跟注（押 ${callBet.toLocaleString()}）`)
      .setEmoji("🤝")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`ch_fold_${gameId}`)
      .setLabel("蓋牌")
      .setEmoji("🏳️")
      .setStyle(ButtonStyle.Danger)
  );
}

// 進行中（flop）：揭露玩家 2 底牌 + 3 公共牌，莊家暗牌。
function playingLines(state) {
  const flop = state.community.slice(0, 3);
  return [
    `🤵 莊家：[ ?? ] [ ?? ]`,
    `🃏 你的底牌：${cardsLine(state.player)}`,
    `🎴 公共牌（翻牌）：${cardsLine(flop)}`,
    "─────────────────────",
    `底注 **${state.ante.toLocaleString()}** ${MONEY_EMOJI}　·　跟注需再押 **${(state.ante * 2).toLocaleString()}** ${MONEY_EMOJI}`,
    `-# 跟注後補發轉牌、河牌並開莊家。莊家需「一對 4」以上才合格。`,
  ];
}

function outcomeHeadline(state) {
  const ante = state.ante;
  if (state.result === "fold") {
    return `🏳️ **你蓋牌了** －${ante.toLocaleString()} ${MONEY_EMOJI}（棄底注）`;
  }
  const callBet = state.callBet || ante * 2;
  const stake = ante + callBet;
  const net = (state.payout || 0) - stake;
  const playerCat = categoryLabel(state.playerScore);
  const dealerCat = categoryLabel(state.dealerScore);
  const qualifyText = state.dealerQualified
    ? `莊家合格（${dealerCat}）`
    : `莊家不合格（${dealerCat}）`;

  switch (state.result) {
    case "dealer_no_qualify":
      return `✨ **莊家不合格！** 你的${playerCat} ＋${net.toLocaleString()} ${MONEY_EMOJI}（底注照賠、跟注退回）`;
    case "win":
      return `🎉 **你贏了！** 你的${playerCat} 勝 ${qualifyText} ＋${net.toLocaleString()} ${MONEY_EMOJI}`;
    case "push":
      return `🤝 **平手** 你的${playerCat}＝莊家，退回 ${stake.toLocaleString()} ${MONEY_EMOJI}`;
    case "lose":
    default:
      return `💸 **莊家贏了** ${qualifyText} 勝你的${playerCat} －${stake.toLocaleString()} ${MONEY_EMOJI}`;
  }
}

function settledLines(state) {
  const lines = [
    `🤵 莊家：${cardsLine(state.dealer)}　→ ${categoryLabel(state.dealerScore)}`,
    `🃏 你的底牌：${cardsLine(state.player)}`,
    `🎴 公共牌：${cardsLine(state.community)}`,
    "─────────────────────",
    `你的牌型：**${categoryLabel(state.playerScore)}**`,
  ];
  return lines;
}

// 蓋牌結算：不揭露莊家，只說明結果。
function foldedLines(state) {
  return [
    `🤵 莊家：[ ?? ] [ ?? ]（你已蓋牌）`,
    `🃏 你的底牌：${cardsLine(state.player)}`,
    `🎴 公共牌（翻牌）：${cardsLine(state.community.slice(0, 3))}`,
  ];
}

function settleOutcome(state) {
  if (state.status !== "settled") return { outcome: "neutral", net: undefined };
  const ante = state.ante;
  if (state.result === "fold") {
    return { outcome: "lose", net: -ante };
  }
  const callBet = state.callBet || ante * 2;
  const stake = ante + callBet;
  const net = (state.payout || 0) - stake;
  let outcome;
  if (net > 0) {
    const cat = state.playerScore?.[0];
    outcome = cat >= 7 ? "jackpot" : "win"; // 葫蘆以上 → 金色 jackpot
  } else if (net < 0) outcome = "lose";
  else outcome = "neutral";
  return { outcome, net };
}

function totalStakeOf(state) {
  if (state.status === "playing") return state.ante;
  if (state.result === "fold") return state.ante;
  return state.ante + (state.callBet || state.ante * 2);
}

function renderMessage(state, { username, balance, userId, avatarURL } = {}) {
  const isPlaying = state.status === "playing";

  let lines;
  let headline = null;
  if (isPlaying) {
    lines = playingLines(state);
  } else if (state.result === "fold") {
    lines = foldedLines(state);
    headline = outcomeHeadline(state);
  } else {
    lines = settledLines(state);
    headline = outcomeHeadline(state);
  }

  const { outcome, net } = settleOutcome(state);

  const components = isPlaying
    ? [buildActionRow(state)]
    : state.userId
      ? [buildReplayRow("casinoHoldem", state.userId, { name: username })]
      : [];

  const embed = buildCasinoEmbed({
    game: "🃏 賭場德州撲克",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline,
    lines,
    bet: totalStakeOf(state),
    net: isPlaying ? undefined : net,
    balance: isPlaying || typeof balance !== "number" ? undefined : balance,
    footer: isPlaying ? "跟注或蓋牌？" : undefined,
  });

  return { content: "", embeds: [embed], components, files: [] };
}

module.exports = { renderMessage, formatCard, anteOddsMultiplier };
