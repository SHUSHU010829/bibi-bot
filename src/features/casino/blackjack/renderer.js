// 把 game state 渲染成 Discord 訊息 payload。
// 給 /二十一點 開局時用，給 button handler 更新時也用同一份。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { evaluateHand } = require("./hand");
const { FIVE_CARD_THRESHOLD } = require("./engine");
const { buildReplayRow } = require("../replay");
const generateBlackjackCard = require("../../../utils/generateBlackjackCard");

const SUIT_EMOJI = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function formatCard(card) {
  return `${RANK_LABEL[card[0]]}${SUIT_EMOJI[card[1]]}`;
}

function renderHandLine(label, cards, total, isHidden) {
  if (isHidden) {
    // 莊家暗牌：只顯示第一張，第二張用問號蓋住
    return `${label}：[ ${formatCard(cards[0])} ] [ ?? ]　= ?`;
  }
  const parts = cards.map((c) => `[ ${formatCard(c)} ]`).join(" ");
  return `${label}：${parts}　= ${total}`;
}

function buildButtons(state, balance) {
  const gameId = state.gameId;
  const isPlaying = state.status === "playing";
  const activeHand = state.hands?.[state.activeIndex];
  const canHitOrStand =
    isPlaying && !!activeHand && !activeHand.fromSplitAces;
  const canDouble =
    isPlaying &&
    !!activeHand &&
    activeHand.cards.length === 2 &&
    !activeHand.doubled &&
    !activeHand.fromSplitAces &&
    balance >= state.bet;
  const canSplitBtn =
    isPlaying &&
    !state.isSplit &&
    state.hands?.length === 1 &&
    activeHand?.cards.length === 2 &&
    canSplitFromCards(activeHand.cards) &&
    balance >= state.bet;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj_hit_${gameId}`)
      .setLabel("要牌")
      .setEmoji("🃏")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canHitOrStand),
    new ButtonBuilder()
      .setCustomId(`bj_stand_${gameId}`)
      .setLabel("停牌")
      .setEmoji("✋")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canHitOrStand),
    new ButtonBuilder()
      .setCustomId(`bj_double_${gameId}`)
      .setLabel("加倍")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble),
    new ButtonBuilder()
      .setCustomId(`bj_split_${gameId}`)
      .setLabel("分牌")
      .setEmoji("✂️")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canSplitBtn)
  );
}

const RANK_VALUE = {
  A: 1, T: 10, J: 10, Q: 10, K: 10,
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};
function canSplitFromCards(cards) {
  if (!cards || cards.length !== 2) return false;
  return RANK_VALUE[cards[0][0]] === RANK_VALUE[cards[1][0]];
}

function totalStakeOf(state) {
  if (Array.isArray(state.hands) && state.hands.length > 0) {
    return state.hands.reduce(
      (s, h) => s + h.bet * (h.doubled ? 2 : 1),
      0
    );
  }
  return state.bet * (state.doubled ? 2 : 1);
}

function settleHeadline(state) {
  const stake = totalStakeOf(state);
  switch (state.result) {
    case "blackjack":
      return `🎉 **BLACKJACK！** ＋${state.payout.toLocaleString()} credits`;
    case "fivecard":
      return `🏆 **過五關！** ＋${state.payout.toLocaleString()} credits`;
    case "dealerfivecard":
      return `🛡️ **莊家過五關** －${stake.toLocaleString()} credits，下次加油！`;
    case "win":
      return `✨ **你贏了！** ＋${state.payout.toLocaleString()} credits`;
    case "push":
      return `🤝 **平手** 退回 ${stake.toLocaleString()} credits`;
    case "lose":
      return `💸 **莊家贏了** －${stake.toLocaleString()} credits，下次加油！`;
    default:
      return "";
  }
}

// 依據 state 產生純文字訊息（M2 版）。M3 會額外生圖。
function renderText(state, { username, balance } = {}) {
  const isPlaying = state.status === "playing";
  const dealerEval = evaluateHand(state.dealerHand);
  const hands = Array.isArray(state.hands) && state.hands.length > 0
    ? state.hands
    : [{
        cards: state.playerHand,
        bet: state.bet,
        doubled: !!state.doubled,
        result: null,
      }];

  const dealerLine = renderHandLine(
    "莊家",
    state.dealerHand,
    dealerEval.total,
    isPlaying // 結算前都暗牌
  );

  const handle = username ? `@${username}` : "";
  const totalStake = totalStakeOf(state);
  const stakeLabel = state.isSplit
    ? `Bet: ${state.bet.toLocaleString()} ×2手 = **${totalStake.toLocaleString()}**`
    : (hands[0].doubled
        ? `Bet: ${state.bet.toLocaleString()} ×2 = **${totalStake.toLocaleString()}**`
        : `Bet: **${state.bet.toLocaleString()}**`);

  const lines = [
    `🃏 **BLACKJACK** ・ ${stakeLabel}${handle ? ` ・ ${handle}` : ""}`,
    "─────────────────────",
    dealerLine,
  ];

  hands.forEach((h, i) => {
    const ev = evaluateHand(h.cards);
    const label = state.isSplit ? `第 ${i + 1} 手` : "你的";
    const marker = isPlaying && i === state.activeIndex && state.isSplit ? " ▶" : "";
    lines.push(renderHandLine(label + marker, h.cards, ev.total, false));
    if (isPlaying && h.cards.length >= 3 && !ev.isBust) {
      const remain = FIVE_CARD_THRESHOLD - h.cards.length;
      if (remain > 0 && (!state.isSplit || i === state.activeIndex)) {
        lines.push(`🏆 再抽 ${remain} 張未爆牌即過五關（賠率 2:1）`);
      }
    }
  });

  if (!isPlaying) {
    lines.push("─────────────────────");
    if (state.isSplit) {
      hands.forEach((h, i) => {
        lines.push(`第 ${i + 1} 手：${perHandHeadline(h)}`);
      });
    }
    lines.push(settleHeadline(state));
    if (typeof balance === "number") {
      lines.push(`餘額：**${balance.toLocaleString()}** credits`);
    }
  }

  return lines.join("\n");
}

function perHandHeadline(hand) {
  const stake = hand.bet * (hand.doubled ? 2 : 1);
  switch (hand.result) {
    case "blackjack":
      return `BLACKJACK ＋${hand.payout.toLocaleString()}`;
    case "fivecard":
      return `過五關 ＋${hand.payout.toLocaleString()}`;
    case "dealerfivecard":
      return `莊家過五關 －${stake.toLocaleString()}`;
    case "win":
      return `贏 ＋${hand.payout.toLocaleString()}`;
    case "push":
      return `平手 退回 ${stake.toLocaleString()}`;
    case "lose":
    default:
      return `輸 －${stake.toLocaleString()}`;
  }
}

function buildSettleHeadlineLine(state) {
  if (state.status !== "settled") return null;
  return settleHeadline(state);
}

async function renderMessage(state, { username, balance } = {}) {
  const components =
    state.status === "playing"
      ? [buildButtons(state, balance ?? 0)]
      : state.status === "settled" && state.userId
        ? [buildReplayRow("blackjack", state.userId, { name: username })]
        : [];

  let content = "";
  let files = [];
  try {
    const buf = await generateBlackjackCard({
      username,
      state,
      balance: balance ?? 0,
    });
    files = [
      new AttachmentBuilder(buf, { name: `blackjack-${state.gameId}.png` }),
    ];
    // 圖卡已含完整資訊；只在結算時補一句結算文字方便手機通知預覽
    const settleLine = buildSettleHeadlineLine(state);
    if (settleLine) content = settleLine;
  } catch (e) {
    // 圖卡生成失敗就 fallback 純文字
    console.log(`[WARN] blackjack card render failed, falling back to text: ${e.message}`);
    content = renderText(state, { username, balance });
  }

  return { content, components, files };
}

module.exports = {
  renderMessage,
  renderText,
  buildButtons,
  formatCard,
  settleHeadline,
};
