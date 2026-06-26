// 搶紅包訊息渲染（純組裝，不接觸 DB）。
// 用一般訊息 content + 一排按鈕（搶紅包是公開、熱鬧導向，故不走 ephemeral）。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const MODE_LABEL = { lucky: "拚手氣", even: "均分" };

function grabberLines(state, { highlightBest = false } = {}) {
  if (!state.grabbers?.length) return "_還沒有人搶～_";
  const sorted = [...state.grabbers].sort((a, b) => b.amount - a.amount);
  const bestId = sorted[0]?.userId;
  return state.grabbers
    .map((g) => {
      const crown = highlightBest && g.userId === bestId ? " 👑手氣王" : "";
      return `・<@${g.userId}> 搶到 **${g.amount.toLocaleString()}** ${MONEY_EMOJI}${crown}`;
    })
    .join("\n");
}

function buildOpenPayload(state) {
  const grabbedCount = state.grabbers?.length || 0;
  const expiresEpoch = Math.floor(new Date(state.expiresAt).getTime() / 1000);
  const content =
    `# 🧧 <@${state.hostUserId}> 發了一包紅包！\n` +
    `**${MODE_LABEL[state.mode] || state.mode}**　共 **${state.totalAmount.toLocaleString()}** ${MONEY_EMOJI} / **${state.totalCount}** 包\n` +
    `已搶 **${grabbedCount}** / ${state.totalCount} 包\n\n` +
    `${grabberLines(state)}\n\n` +
    `-# 手快有，手慢無！<t:${expiresEpoch}:R> 截止，未搶完自動退回發包人`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rp_grab_${state.gameId}`)
      .setLabel("搶紅包")
      .setEmoji("🧧")
      .setStyle(ButtonStyle.Danger)
  );
  return { content, components: [row] };
}

function buildClosedPayload(state, { refunded = 0 } = {}) {
  const grabbedAmount = (state.grabbers || []).reduce((s, g) => s + g.amount, 0);
  const closedReason =
    state.grabbers?.length >= state.totalCount
      ? "🧧 紅包搶光啦！"
      : "🧧 紅包時間到～";
  const refundLine =
    refunded > 0
      ? `\n剩下 **${refunded.toLocaleString()}** ${MONEY_EMOJI} 已退回給 <@${state.hostUserId}>`
      : "";

  const content =
    `# ${closedReason}\n` +
    `<@${state.hostUserId}> 的紅包 **${state.totalAmount.toLocaleString()}** ${MONEY_EMOJI} / ${state.totalCount} 包，` +
    `搶出 **${grabbedAmount.toLocaleString()}** ${MONEY_EMOJI}${refundLine}\n\n` +
    `${grabberLines(state, { highlightBest: true })}`;

  return { content, components: [] };
}

module.exports = { buildOpenPayload, buildClosedPayload, MODE_LABEL };
