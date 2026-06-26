// 俄羅斯輪盤訊息渲染（Embed 呈現，公開、熱鬧導向）。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");
const { MODES } = require("./engine");

function modeLabel(mode) {
  return MODES[mode]?.label || MODES.standard.label;
}

function buildWaitingPayload(state) {
  const expiresEpoch = Math.floor(new Date(state.expiresAt).getTime() / 1000);
  const pot = state.players.reduce((s, p) => s + p.ante, 0);
  const playerLines = state.players
    .map((p, i) => `${i + 1}. <@${p.userId}>`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xb83030)
    .setTitle("🔫 俄羅斯輪盤")
    .setDescription(
      `莊家 <@${state.hostUserId}> 開了一桌！轉輪一響，**中彈者輸光**，生還者平分池底。`
    )
    .addFields(
      { name: "模式", value: modeLabel(state.mode), inline: true },
      { name: "賭注", value: `${state.ante.toLocaleString()} ${MONEY_EMOJI} / 人`, inline: true },
      { name: "池底", value: `${pot.toLocaleString()} ${MONEY_EMOJI}`, inline: true },
      {
        name: `牌桌（${state.players.length}/${state.maxPlayers}）`,
        value: playerLines || "_等待玩家加入…_",
        inline: true,
      },
      { name: "開轉倒數", value: `<t:${expiresEpoch}:R>`, inline: true }
    )
    .setFooter({ text: "至少 2 人才能開轉 · 時間到自動開轉（不足 2 人退款）" });

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
  return { content: "", embeds: [embed], components: [row] };
}

// 戲劇化的扣板機序列：每位玩家依序扣板機，中彈者「砰」、生還者「喀（空膛）」。
function triggerSequence(state) {
  const loserSet = new Set(state.loserIds || []);
  return state.players
    .map((p) => {
      if (loserSet.has(p.userId)) {
        return `・<@${p.userId}>　💥 **砰！中彈！**`;
      }
      return `・<@${p.userId}>　🔫 喀…（空膛）`;
    })
    .join("\n");
}

function buildFinishedPayload(state) {
  const loserIds = state.loserIds || [];
  const winners = state.payouts || [];
  const loserLine = loserIds.length
    ? loserIds.map((id) => `<@${id}>`).join("　")
    : "（無）";
  const winnerLine = winners.length
    ? winners
        .map((w) => `<@${w.userId}> +${w.amount.toLocaleString()} ${MONEY_EMOJI}`)
        .join("　")
    : "（無）";

  const embed = new EmbedBuilder()
    .setColor(0x8c7a2a)
    .setTitle("🔫 轉輪停了…")
    .setDescription(triggerSequence(state))
    .addFields(
      {
        name: `💀 中彈（${loserIds.length} 人各輸 ${state.ante.toLocaleString()} ${MONEY_EMOJI}）`,
        value: loserLine,
      },
      {
        name: `🏆 倖存者平分池底（${(state.pot || 0).toLocaleString()}）`,
        value: winnerLine,
      }
    );
  // 內容帶上中彈者提及，讓他們收到通知
  const ping = loserIds.length
    ? `💥 ${loserIds.map((id) => `<@${id}>`).join("　")} 中彈！`
    : "💥 轉輪停了！";
  return { content: ping, embeds: [embed], components: [] };
}

function buildCancelledPayload(state, { reason = "cancelled" } = {}) {
  const head =
    reason === "not_enough"
      ? "人數不足 2 人，這桌取消了，賭注已全數退回。"
      : "這桌取消了，賭注已全數退回。";
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle("🔫 俄羅斯輪盤 已取消")
    .setDescription(head)
    .addFields({
      name: "牌桌",
      value: `莊家 <@${state.hostUserId}>　賭注 ${state.ante.toLocaleString()} ${MONEY_EMOJI}/人`,
    });
  return { content: "", embeds: [embed], components: [] };
}

module.exports = {
  buildWaitingPayload,
  buildFinishedPayload,
  buildCancelledPayload,
};
