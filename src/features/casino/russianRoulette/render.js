// 俄羅斯輪盤訊息渲染（純組裝）。公開、熱鬧導向。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

function buildWaitingPayload(state) {
  const expiresEpoch = Math.floor(new Date(state.expiresAt).getTime() / 1000);
  const pot = state.players.reduce((s, p) => s + p.ante, 0);
  const playerLines = state.players
    .map((p, i) => `${i + 1}. <@${p.userId}>`)
    .join("\n");

  const content =
    `# 🔫 俄羅斯輪盤　賭注 **${state.ante.toLocaleString()}** ${MONEY_EMOJI}/人\n` +
    `莊家 <@${state.hostUserId}> 開了一桌！轉輪一響，中彈者輸光，其餘人平分池底。\n\n` +
    `**目前牌桌（${state.players.length}/${state.maxPlayers}）　池底 ${pot.toLocaleString()} ${MONEY_EMOJI}**\n` +
    `${playerLines}\n\n` +
    `-# 至少 2 人才能開轉・<t:${expiresEpoch}:R> 自動開轉（不足 2 人則退款）`;

  const joinFull = state.players.length >= state.maxPlayers;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rr_join_${state.gameId}`)
      .setLabel(joinFull ? "已滿桌" : `加入（押 ${state.ante.toLocaleString()}）`)
      .setEmoji("🔫")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(joinFull),
    new ButtonBuilder()
      .setCustomId(`rr_start_${state.gameId}`)
      .setLabel("開轉")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`rr_cancel_${state.gameId}`)
      .setLabel("取消")
      .setEmoji("✖️")
      .setStyle(ButtonStyle.Danger)
  );
  return { content, components: [row] };
}

// 戲劇化的扣板機序列：中彈者前面的人「喀（空膛）」，中彈者「砰」。
function triggerSequence(state) {
  const lines = [];
  for (let i = 0; i < state.players.length; i += 1) {
    const p = state.players[i];
    if (i < state.loserIndex) {
      lines.push(`・<@${p.userId}>　🔫 喀…（空膛）`);
    } else if (i === state.loserIndex) {
      lines.push(`・<@${p.userId}>　💥 **砰！中彈！**`);
      break;
    }
  }
  return lines.join("\n");
}

function buildFinishedPayload(state) {
  const winners = state.payouts || [];
  const winnerLine = winners.length
    ? winners
        .map((w) => `<@${w.userId}> +${w.amount.toLocaleString()} ${MONEY_EMOJI}`)
        .join("　")
    : "（無）";

  const content =
    `# 🔫 轉輪停了…\n` +
    `${triggerSequence(state)}\n\n` +
    `💀 <@${state.loserId}> 中彈，輸掉 **${state.ante.toLocaleString()}** ${MONEY_EMOJI}！\n` +
    `🏆 倖存者平分池底（池底 ${state.pot.toLocaleString()}）：\n${winnerLine}`;

  return { content, components: [] };
}

function buildCancelledPayload(state, { reason = "cancelled" } = {}) {
  const head =
    reason === "not_enough"
      ? "🔫 人數不足 2 人，這桌取消了，賭注已全數退回。"
      : "🔫 這桌取消了，賭注已全數退回。";
  const content =
    `# ${head}\n莊家 <@${state.hostUserId}>　賭注 ${state.ante.toLocaleString()} ${MONEY_EMOJI}/人`;
  return { content, components: [] };
}

module.exports = {
  buildWaitingPayload,
  buildFinishedPayload,
  buildCancelledPayload,
};
