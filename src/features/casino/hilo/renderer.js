// HI-LO Discord 訊息 payload 渲染。
// 開局與每次按鈕互動共用同一份。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { calcOdds, valueOf } = require("./engine");
const { buildReplayRow } = require("../replay");
const generateHiloCard = require("../../../utils/generateHiloCard");

const SUIT_EMOJI = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_LABEL = {
  A: "A", T: "10", J: "J", Q: "Q", K: "K",
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
};

function formatCard(card) {
  if (!card) return "??";
  return `${RANK_LABEL[card[0]]}${SUIT_EMOJI[card[1]]}`;
}

function buildButtons(state) {
  const gameId = state.gameId;
  const playing = state.status === "playing";
  const odds = playing
    ? calcOdds(state.baseCard, state.deck, state.houseEdge)
    : null;

  const hiMul = odds?.multipliers.hi || 0;
  const loMul = odds?.multipliers.lo || 0;
  const sameMul = odds?.multipliers.same || 0;
  const canCashOut = playing && state.wins > 0;

  const hiLabel = hiMul > 0 ? `HI ×${hiMul.toFixed(2)}` : "HI ×—";
  const loLabel = loMul > 0 ? `LO ×${loMul.toFixed(2)}` : "LO ×—";
  const sameLabel =
    sameMul > 0 ? `SAME ×${sameMul.toFixed(2)}` : "SAME ×—";

  const cashOutAmount = canCashOut
    ? Math.floor(state.bet * state.accMultiplier + 1e-9)
    : 0;
  const cashOutLabel = canCashOut
    ? `收手 +${cashOutAmount.toLocaleString()}`
    : "收手";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`hl_hi_${gameId}`)
      .setLabel(hiLabel)
      .setEmoji("⬆️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!playing || hiMul <= 0),
    new ButtonBuilder()
      .setCustomId(`hl_lo_${gameId}`)
      .setLabel(loLabel)
      .setEmoji("⬇️")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!playing || loMul <= 0),
    new ButtonBuilder()
      .setCustomId(`hl_same_${gameId}`)
      .setLabel(sameLabel)
      .setEmoji("🟰")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!playing || sameMul <= 0),
    new ButtonBuilder()
      .setCustomId(`hl_cash_${gameId}`)
      .setLabel(cashOutLabel)
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canCashOut)
  );
}

function settleHeadline(state) {
  switch (state.result) {
    case "cashout":
      return `💰 **收手成功！** 拿走 ${state.payout.toLocaleString()} credits（×${state.accMultiplier.toFixed(2)}）`;
    case "lose":
      return `💸 **猜錯了！** －${state.bet.toLocaleString()} credits，下次加油！`;
    case "win":
      return `🏆 **滿關獎勵！** ＋${state.payout.toLocaleString()} credits`;
    default:
      return "";
  }
}

function renderText(state, { username, balance } = {}) {
  const last = state.history[state.history.length - 1];
  const isPlaying = state.status === "playing";
  const handle = username ? `@${username}` : "";

  const odds = isPlaying
    ? calcOdds(state.baseCard, state.deck, state.houseEdge)
    : null;

  const lines = [
    `🎴 **HI-LO** ・ Bet: **${state.bet.toLocaleString()}**${handle ? ` ・ ${handle}` : ""}`,
    "─────────────────────",
    `底牌：[ ${formatCard(state.baseCard)} ] ＝ ${valueOf(state.baseCard)}`,
  ];

  if (last) {
    const tag = last.correct ? "✅ 對" : "❌ 錯";
    lines.push(
      `上一把：猜 ${last.guess.toUpperCase()} → 翻出 [ ${formatCard(last.drawn)} ] ${tag}`
    );
  }

  lines.push(
    `連勝：${state.wins} ・ 累積倍率：×${state.accMultiplier.toFixed(2)}`
  );

  if (isPlaying && odds) {
    const m = odds.multipliers;
    const fmt = (x) => (x > 0 ? `×${x.toFixed(2)}` : "×—");
    lines.push(
      `下一張：HI ${fmt(m.hi)} ・ LO ${fmt(m.lo)} ・ SAME ${fmt(m.same)}`
    );
    if (state.wins > 0) {
      const cash = Math.floor(state.bet * state.accMultiplier + 1e-9);
      lines.push(`收手可拿：**${cash.toLocaleString()}** credits`);
    }
  }

  if (!isPlaying) {
    lines.push("─────────────────────");
    lines.push(settleHeadline(state));
    if (typeof balance === "number") {
      lines.push(`餘額：**${balance.toLocaleString()}** credits`);
    }
  }

  return lines.join("\n");
}

async function renderMessage(state, { username, balance } = {}) {
  const components =
    state.status === "playing"
      ? [buildButtons(state)]
      : state.status === "settled" && state.userId
        ? [buildReplayRow("hilo", state.userId, { name: username })]
        : [];

  let content = "";
  let files = [];
  try {
    const buf = await generateHiloCard({
      username,
      state,
      balance: balance ?? 0,
    });
    files = [
      new AttachmentBuilder(buf, { name: `hilo-${state.gameId}.png` }),
    ];
    if (state.status === "settled") {
      content = settleHeadline(state);
    }
  } catch (e) {
    console.log(`[WARN] hilo card render failed, falling back to text: ${e.message}`);
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
