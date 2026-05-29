// 射龍門 Discord 訊息 payload 渲染。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { classifyDeck, valueOf } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
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

// 結算時的輸贏判定：回傳顏色用的 outcome 與淨輸贏 net。
// net = 派彩 - 本局總投入（入場費 ante + 鎖倉 lock），入場費一律不退。
function settleOutcome(state) {
  if (state.status !== "settled") return { outcome: "neutral", net: undefined };
  const staked = (state.ante || 0) + (state.lock || 0);
  const net = (state.payout || 0) - staked;
  let outcome;
  if (net > 0) outcome = "win";
  else if (net < 0) outcome = "lose";
  else outcome = "neutral";
  return { outcome, net };
}

// 圖片渲染失敗時，把柱牌狀況寫進 embed 內文的備援文字行。
function gameStatusLines(state) {
  const awaiting = state.status === "awaitingChoice";
  const lines = [
    `龍門：[ ${formatCard(state.gateLow)} ] ─── [ ${formatCard(state.gateHigh)} ]`,
    `點數：${valueOf(state.gateLow)}  ─  ${valueOf(state.gateHigh)}`,
  ];
  if (awaiting) {
    const cls = classifyDeck(state.gateLow, state.gateHigh, state.deck);
    lines.push(
      `機率：中間 ${cls.between}/${cls.total}　外面 ${cls.outside}/${cls.total}　碰柱 ${cls.hit}/${cls.total}`
    );
    lines.push(`賠率：中間 **×${state.multiplier.toFixed(2)}**　外面 −1×　碰柱 −2×`);
  } else if (state.thirdCard) {
    lines.push(`開牌：[ ${formatCard(state.thirdCard)} ] ＝ ${valueOf(state.thirdCard)}`);
  }
  return lines;
}

async function renderMessage(
  state,
  { username, balance, userId, avatarURL } = {}
) {
  const buttons = buildButtons(state);
  const components = buttons
    ? [buttons]
    : state.status === "settled" && state.userId
      ? [buildReplayRow("dragonGate", state.userId, { name: username })]
      : [];

  const awaiting = state.status === "awaitingChoice";
  const { outcome, net } = settleOutcome(state);

  let files = [];
  let imageName;
  let fallbackLines = [];
  try {
    const buf = await generateDragonGateCard({
      username,
      state,
      balance: balance ?? 0,
    });
    imageName = `dragon-gate-${state.gameId}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
  } catch (e) {
    console.log(
      `[WARN] dragonGate card render failed, falling back to text: ${e.message}`
    );
    fallbackLines = gameStatusLines(state);
  }

  const embed = buildCasinoEmbed({
    game: "🐉 射龍門",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline: awaiting ? null : buildSettleHeadlineLine(state),
    // 下注前以入場費為下注欄；補注後改顯示鎖倉金額
    lines: fallbackLines,
    bet: awaiting ? state.ante || 0 : state.lock || state.ante || 0,
    net: awaiting ? undefined : net,
    balance: awaiting || typeof balance !== "number" ? undefined : balance,
    imageName,
    footer: awaiting
      ? `入場費 ${(state.ante || 0).toLocaleString()} ・ 賠率 ×${(state.multiplier || 0).toFixed(2)}（房費不退）`
      : undefined,
  });

  return { content: "", embeds: [embed], components, files };
}

module.exports = {
  renderMessage,
  renderText,
  buildButtons,
  settleHeadline,
  formatCard,
};
