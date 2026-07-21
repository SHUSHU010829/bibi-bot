// 踩地雷 Discord 訊息 payload 渲染。開局與每次按鈕互動共用同一份。
//
// 盤面以按鈕格呈現（cols×rows），每格一顆按鈕：
//   未翻 ⬛（可按）  安全 💎（已翻）  地雷 💣  踩爆 💥
// 最後一排放收手按鈕。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const { nextMultiplier } = require("./engine");
const { buildReplayRow } = require("../replay");
const { buildCasinoEmbed } = require("../casinoEmbed");

// 某一格在當前 state 下該顯示的圖示與按鈕樣式。
function tileFace(state, tile) {
  const settled = state.status !== "playing";
  const revealed = state.revealed.includes(tile);
  const mine = state.mineSet.includes(tile);

  if (revealed) return { emoji: "💎", style: ButtonStyle.Success, disabled: true };
  if (settled && tile === state.hitTile) {
    return { emoji: "💥", style: ButtonStyle.Danger, disabled: true };
  }
  if (settled && mine) {
    return { emoji: "💣", style: ButtonStyle.Danger, disabled: true };
  }
  if (settled) return { emoji: "⬜", style: ButtonStyle.Secondary, disabled: true };
  return { emoji: "⬛", style: ButtonStyle.Secondary, disabled: false };
}

function buildBoardRows(state) {
  const rows = [];
  for (let r = 0; r < state.rows; r += 1) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < state.cols; c += 1) {
      const tile = r * state.cols + c;
      const face = tileFace(state, tile);
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`mn_t${tile}_${state.gameId}`)
          .setEmoji(face.emoji)
          .setStyle(face.style)
          .setDisabled(face.disabled)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildCashRow(state) {
  const canCashOut = state.revealed.length > 0;
  const amount = canCashOut
    ? Math.floor(state.bet * state.multiplier + 1e-9)
    : 0;
  const label = canCashOut
    ? `收手 +${amount.toLocaleString()}（×${state.multiplier.toFixed(2)}）`
    : "收手（至少翻 1 格）";
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mn_cash_${state.gameId}`)
      .setLabel(label)
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canCashOut)
  );
}

function settleHeadline(state) {
  switch (state.result) {
    case "win":
      return `💎 **全部掃雷成功！** 拿走 ${state.payout.toLocaleString()} credits（×${state.multiplier.toFixed(2)}）`;
    case "cashout":
      return `${MONEY_EMOJI} **收手成功！** 拿走 ${state.payout.toLocaleString()} credits（×${state.multiplier.toFixed(2)}）`;
    case "lose":
      return `💥 **踩到地雷！** －${state.bet.toLocaleString()} credits，翻開 ${state.revealed.length} 格止步，下次加油！`;
    default:
      return "";
  }
}

function settleOutcome(state) {
  if (state.status === "playing") return { outcome: "neutral", net: undefined };
  switch (state.result) {
    case "lose":
      return { outcome: "lose", net: -state.bet };
    case "cashout":
    case "win":
      return { outcome: "win", net: (state.payout || 0) - state.bet };
    default:
      return { outcome: "neutral", net: undefined };
  }
}

async function renderMessage(state, { username, balance, userId, avatarURL } = {}) {
  const isPlaying = state.status === "playing";
  const { outcome, net } = settleOutcome(state);

  const lines = [
    `地雷：💣 ×${state.mines}　・　安全格：💎 ×${state.n - state.mines}　・　已翻：${state.revealed.length}`,
  ];
  if (isPlaying) {
    if (state.revealed.length > 0) {
      const cash = Math.floor(state.bet * state.multiplier + 1e-9);
      lines.push(
        `目前倍率：×${state.multiplier.toFixed(2)}　・　收手可拿 **${cash.toLocaleString()}** credits`
      );
    }
    lines.push(`再翻一格安全 → ×${nextMultiplier(state).toFixed(2)}`);
  }

  // 結算後保留盤面（全禁用），讓玩家看到雷點與踩爆格，再附「再來一局」。
  const boardRows = buildBoardRows(state);
  const components = isPlaying
    ? [...boardRows, buildCashRow(state)]
    : state.userId
      ? [...boardRows, buildReplayRow("mines", state.userId, { name: username })]
      : boardRows;

  const embed = buildCasinoEmbed({
    game: "💣 踩地雷",
    user: { id: userId || state.userId, displayName: username, avatarURL },
    outcome,
    headline: isPlaying ? null : settleHeadline(state),
    lines,
    bet: state.bet,
    net: isPlaying ? undefined : net,
    balance: isPlaying || typeof balance !== "number" ? undefined : balance,
    footer: isPlaying
      ? `倍率 ×${state.multiplier.toFixed(2)} ・ 翻開 ${state.revealed.length}/${state.n - state.mines}`
      : undefined,
  });

  return { content: "", embeds: [embed], components, files: [] };
}

module.exports = {
  renderMessage,
  settleHeadline,
  buildBoardRows,
};
