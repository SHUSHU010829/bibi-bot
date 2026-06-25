// 刮刮樂（對中獎號碼版）Discord 訊息 payload 渲染。
//
// 主視覺是刮刮卡圖（generateScratchCard）：上方幸運號碼、下方 3×3 你的號碼。
// 按鈕是刮開介面：未刮 ❓，刮開後顯示號碼；對中幸運號碼的格變綠。

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const { isMatch } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");
const generateScratchCard = require("../../../utils/generateScratchCard");

function cellFace(state, idx) {
  const revealed = state.revealed.includes(idx);
  if (!revealed) {
    return { label: null, emoji: "❓", style: ButtonStyle.Secondary, disabled: false };
  }
  const matched = isMatch(state, idx);
  return {
    label: String(state.cells[idx].number),
    emoji: matched ? "🎯" : undefined,
    style: matched ? ButtonStyle.Success : ButtonStyle.Secondary,
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
      const btn = new ButtonBuilder()
        .setCustomId(`sc_c${idx}_${state.gameId}`)
        .setStyle(face.style)
        .setDisabled(face.disabled);
      if (face.label) btn.setLabel(face.label);
      if (face.emoji) btn.setEmoji(face.emoji);
      row.addComponents(btn);
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
    const num = state.cells[state.winIndex]?.number;
    return `🎯 **對中 ${num}！** 中獎 ×${state.multiplier} → 拿走 ${state.payout.toLocaleString()} credits`;
  }
  return `🎫 **銘謝惠顧…** 沒對中任何幸運號碼，再來一張試試！`;
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
          `幸運號碼：**${state.luckyNumbers.join("・")}**`,
          `刮開你的號碼，對中任一個就中獎！（已刮 ${state.revealed.length}/9）`,
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
