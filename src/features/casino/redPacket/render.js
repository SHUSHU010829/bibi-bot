// 搶紅包訊息渲染（純組裝，不接觸 DB）。
// 用一般訊息 content + 一排按鈕（搶紅包是公開、熱鬧導向，故不走 ephemeral）。
//
// 傻瓜紅包（kind === "prank"）的開包訊息與一般紅包外觀完全一樣 —— 看顯示金額/包數，
// 不洩漏實情；要等到 buildClosedPayload 才會揭曉「🤡 X 人被騙了」。

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI } = require("../../../constants/coin");

const MODE_LABEL = { lucky: "拚手氣", even: "均分" };

function displayAmountOf(state) {
  return state.displayAmount ?? state.totalAmount;
}
function displayCountOf(state) {
  return state.displayCount ?? state.totalCount;
}

function grabberLines(state, { revealAmounts = false, highlightBest = false, prankReveal = false } = {}) {
  if (!state.grabbers?.length) {
    return prankReveal ? "_沒人上當，發包人尷尬了 😶_" : "_還沒有人搶～_";
  }
  if (!revealAmounts) {
    return state.grabbers
      .map((g) => `・<@${g.userId}> 已領取`)
      .join("\n");
  }
  const sorted = [...state.grabbers].sort((a, b) => b.amount - a.amount);
  const bestId = sorted[0]?.userId;
  return state.grabbers
    .map((g) => {
      const crown = highlightBest && g.userId === bestId ? " 👑手氣王" : "";
      const prankMark = prankReveal ? " 🤡 上當了！" : "";
      return `・<@${g.userId}> 搶到 **${g.amount.toLocaleString()}** ${MONEY_EMOJI}${crown}${prankMark}`;
    })
    .join("\n");
}

function buildOpenPayload(state) {
  const grabbedCount = state.grabbers?.length || 0;
  const expiresEpoch = Math.floor(new Date(state.expiresAt).getTime() / 1000);
  const titleLine = state.title ? `> 💬 ${state.title}\n` : "";
  const showAmount = displayAmountOf(state);
  const showCount = displayCountOf(state);
  const content =
    `# 🧧 <@${state.hostUserId}> 發了一包紅包！\n` +
    `${titleLine}` +
    `**${MODE_LABEL[state.mode] || state.mode}**　共 **${showAmount.toLocaleString()}** ${MONEY_EMOJI} / **${showCount}** 包\n` +
    `已搶 **${grabbedCount}** / ${showCount} 包\n\n` +
    `${grabberLines(state)}\n\n` +
    `-# 手快有，手慢無！<t:${expiresEpoch}:R> 截止，未搶完自動退回發包人`;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rp_grab_${state.gameId}`)
      .setLabel("搶紅包")
      .setEmoji("🧧")
      .setStyle(ButtonStyle.Danger)
  );
  return { content, components: [row], allowedMentions: { parse: [] } };
}

function buildClosedPayload(state, { refunded = 0 } = {}) {
  const titleLine = state.title ? `> 💬 ${state.title}\n` : "";

  if (state.kind === "prank") {
    const fooledCount = state.grabbers?.length || 0;
    const header = fooledCount > 0
      ? `# 🤡 哈哈，這是傻瓜紅包！\n`
      : `# 🤡 傻瓜紅包揭曉～沒人上當\n`;
    const subtitle =
      `<@${state.hostUserId}> 發的根本是**空的**！` +
      `${fooledCount > 0 ? `共 **${fooledCount}** 人成功被騙 🎉` : ""}\n\n`;
    const content =
      header +
      `${titleLine}` +
      subtitle +
      `${grabberLines(state, { revealAmounts: true, prankReveal: true })}`;
    return { content, components: [], allowedMentions: { parse: [] } };
  }

  const showAmount = displayAmountOf(state);
  const showCount = displayCountOf(state);
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
    `${titleLine}` +
    `<@${state.hostUserId}> 的紅包 **${showAmount.toLocaleString()}** ${MONEY_EMOJI} / ${showCount} 包，` +
    `搶出 **${grabbedAmount.toLocaleString()}** ${MONEY_EMOJI}${refundLine}\n\n` +
    `${grabberLines(state, { revealAmounts: true, highlightBest: true })}`;

  return { content, components: [], allowedMentions: { parse: [] } };
}

module.exports = { buildOpenPayload, buildClosedPayload, MODE_LABEL };
