// 射龍門 Discord 訊息 payload 渲染。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { classifyDeck, valueOf } = require("./engine");
const { buildReplayRow } = require("../replay");
const generateDragonGateCard = require("../../../utils/generateDragonGateCard");

const SUIT_EMOJI = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function formatCard(card) {
  if (!card) return "🂠";
  return `${RANK_LABEL[card[0]]}${SUIT_EMOJI[card[1]]}`;
}

function buildButtons(state) {
  const gameId = state.gameId;
  if (state.status !== "awaitingChoice") return null;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`dg_bet_${gameId}`)
      .setLabel(`補（×${(state.multiplier || 0).toFixed(2)}）`)
      .setEmoji("🐉")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`dg_fold_${gameId}`)
      .setLabel("不補（棄權）")
      .setEmoji("🏳️")
      .setStyle(ButtonStyle.Secondary)
  );
}

function settleHeadline(state) {
  switch (state.result) {
    case "between": {
      const profit = state.payout - state.lock;
      return `🎯 **射中龍門！** ＋${profit.toLocaleString()} credits（×${state.multiplier.toFixed(2)}）`;
    }
    case "outside":
      return `💨 **射出柱外！** －${state.bet.toLocaleString()} credits`;
    case "hitGate":
      return `💥 **碰柱！** 賠雙倍 －${(state.bet * 2).toLocaleString()} credits`;
    case "fold":
      return `🏳️ **棄權不補** －${(state.ante || 0).toLocaleString()} credits（入場費）`;
    default:
      return "";
  }
}

function renderText(state, { username, balance } = {}) {
  const awaiting = state.status === "awaitingChoice";
  const handle = username ? `@${username}` : "";
  const tieCount = state.pushHistory?.length || 0;

  const lines = [
    `🐉 **射龍門** ・ 入場費 **${(state.ante || 0).toLocaleString()}**${handle ? ` ・ ${handle}` : ""}`,
    `-# 入場費為房費，不論結果一律不退`,
  ];
  if (tieCount > 0) {
    lines.push(`-# 開局重抽 ${tieCount} 次（對柱/連柱）`);
  }
  lines.push("─────────────────────");
  lines.push(`龍門：[ ${formatCard(state.gateLow)} ] ─── [ ${formatCard(state.gateHigh)} ]`);
  lines.push(`點數：${valueOf(state.gateLow)}  ─  ${valueOf(state.gateHigh)}`);

  if (awaiting) {
    const cls = classifyDeck(state.gateLow, state.gateHigh, state.deck);
    lines.push(
      `機率：中間 ${cls.between}/${cls.total}　外面 ${cls.outside}/${cls.total}　碰柱 ${cls.hit}/${cls.total}`
    );
    lines.push(
      `賠率：中間 **×${state.multiplier.toFixed(2)}**　外面 −1×　碰柱 −2×`
    );
    lines.push("補：下注後開第三張；不補：棄權，損失入場費");
  } else {
    if (state.thirdCard) {
      lines.push(`開牌：[ ${formatCard(state.thirdCard)} ] ＝ ${valueOf(state.thirdCard)}`);
    }
    lines.push("─────────────────────");
    lines.push(settleHeadline(state));
    if (typeof balance === "number") {
      lines.push(`餘額：**${balance.toLocaleString()}** credits`);
    }
  }

  return lines.join("\n");
}

function buildSettleHeadlineLine(state) {
  if (state.status !== "settled") return null;
  return settleHeadline(state);
}

async function renderMessage(state, { username, balance } = {}) {
  const buttons = buildButtons(state);
  const components = buttons
    ? [buttons]
    : state.status === "settled" && state.userId
      ? [buildReplayRow("dragonGate", state.userId, { name: username })]
      : [];

  let content = "";
  let files = [];
  try {
    const buf = await generateDragonGateCard({
      username,
      state,
      balance: balance ?? 0,
    });
    files = [
      new AttachmentBuilder(buf, { name: `dragon-gate-${state.gameId}.png` }),
    ];
    const settleLine = buildSettleHeadlineLine(state);
    if (settleLine) content = settleLine;
  } catch (e) {
    console.log(`[WARN] dragonGate card render failed, falling back to text: ${e.message}`);
    content = renderText(state, { username, balance });
  }

  return { content, components, files };
}

module.exports = {
  renderMessage,
  renderText,
  buildButtons,
  settleHeadline,
  formatCard,
};
