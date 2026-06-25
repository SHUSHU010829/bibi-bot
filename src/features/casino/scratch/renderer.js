// 刮刮樂 Discord 訊息 payload 渲染。開局與每次刮開互動共用同一份。
//
// 卡面 3×3 用按鈕格呈現：未刮 ❓（可按）、刮開後顯示符號。
// 結算後中獎的 3 格用綠色按鈕標出，並附「再來一局」。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
const generateScratchCard = require("../../../utils/generateScratchCard");

function cellFace(state, idx) {
  const settled = state.status !== "playing";
  const revealed = state.revealed.includes(idx);
  if (!revealed) {
    return { emoji: "❓", style: ButtonStyle.Secondary, disabled: settled };
  }
  const sym = state.grid[idx];
  const isWinCell = settled && state.winSymbol && sym === state.winSymbol;
  return {
    emoji: sym,
    style: isWinCell ? ButtonStyle.Success : ButtonStyle.Secondary,
    disabled: true,
  };
}

function buildCardRows(state) {
  const rows = [];
  for (let r = 0; r < 3; r += 1) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c += 1) {
      const idx = r * 3 + c;
      const face = cellFace(state, idx);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`sc_c${idx}_${state.gameId}`)
          .setEmoji(face.emoji)
          .setStyle(face.style)
          .setDisabled(face.disabled)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildAllRow(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sc_all_${state.gameId}`)
      .setLabel("全部刮開")
      .setEmoji("🪙")
      .setStyle(ButtonStyle.Primary)
  );
}

function settleHeadline(state) {
  if (state.result === "win") {
    return `🎉 **湊滿三個 ${state.winSymbol}！** 中獎 ×${state.multiplier} → 拿走 ${state.payout.toLocaleString()} credits`;
  }
  return `🪙 **沒湊到三個一樣的…** －${state.bet.toLocaleString()} credits，再刮一張試試！`;
}

function settleOutcome(state) {
  if (state.status === "playing") return { outcome: "neutral", net: undefined };
  return state.result === "win"
    ? { outcome: "win", net: (state.payout || 0) - state.bet }
    : { outcome: "lose", net: -state.bet };
}

async function renderMessage(state, { username, balance, userId, avatarURL } = {}) {
  const isPlaying = state.status === "playing";
  const { outcome, net } = settleOutcome(state);

  let files = [];
  let imageName;
  let fallbackLines = [];
  try {
    const buf = await generateScratchCard(state, { username, balance });
    imageName = `scratch-${state.gameId}-${state.revealed.length}.png`;
    files = [new AttachmentBuilder(buf, { name: imageName })];
  } catch (e) {
    console.log(`[WARN] scratch card render failed, falling back to text: ${e.message}`);
    fallbackLines = isPlaying
      ? [
          `刮開 **${state.revealed.length}/9** 格・湊滿任意三個相同符號就中獎！`,
          "-# 逐格刮，或按「全部刮開」一次揭曉",
        ]
      : [];
  }

  const components = isPlaying
    ? [...buildCardRows(state), buildAllRow(state)]
    : state.userId
      ? [...buildCardRows(state), buildReplayRow("scratch", state.userId, { name: username })]
      : buildCardRows(state);

  const embed = buildCasinoEmbed({
    game: "🎫 刮刮樂",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline: isPlaying ? null : settleHeadline(state),
    lines: fallbackLines,
    bet: state.bet,
    net: isPlaying ? undefined : net,
    balance: isPlaying || typeof balance !== "number" ? undefined : balance,
    imageName,
  });

  return { content: "", embeds: [embed], components, files };
}

module.exports = { renderMessage, buildCardRows, settleHeadline };
