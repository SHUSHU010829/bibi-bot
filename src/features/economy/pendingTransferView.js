const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI, COIN_EMOJI } = require("../../constants/coin");

const ACCEPT_PREFIX = "ptx_accept_";
const REJECT_PREFIX = "ptx_reject_";
const CANCEL_PREFIX = "ptx_cancel_";

const COIN_COLOR = 0x5865f2;
const ITEM_COLOR = 0xfaa61a;
const REFUND_COLOR = 0x95a5a6;
const FAIL_COLOR = 0xe74c3c;
const SUCCESS_COLOR = 0x1abc9c;

function expiresEpoch(offer) {
  return Math.floor(new Date(offer.expires_at).getTime() / 1000);
}

function offerLines(offer, itemDef) {
  if (offer.kind === "coin") {
    const lines = [
      `<@${offer.sender_id}> 想轉給你 **${offer.amount.toLocaleString()}** ${MONEY_EMOJI}`,
    ];
    if (offer.note) lines.push(`📝 備註：${offer.note}`);
    lines.push(`-# 手續費 ${offer.fee.toLocaleString()} 已由對方預付，拒收 / 逾時會全額退回對方。`);
    return lines.join("\n");
  }
  const def = itemDef || {};
  return (
    `<@${offer.sender_id}> 想送你 **${def.emoji || ""} ${def.name || offer.item.key} ×${offer.item.qty}**\n` +
    `-# 收下後若背包放不下，多的會折成 ${COIN_EMOJI} 入帳。`
  );
}

// 待收邀請訊息（含收下 / 拒收 / 取消按鈕）。
function buildOfferContainer(offer, { itemDef } = {}) {
  const isCoin = offer.kind === "coin";
  const container = new ContainerBuilder()
    .setAccentColor(isCoin ? COIN_COLOR : ITEM_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`<@${offer.recipient_id}>`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(isCoin ? "# 💸 轉帳邀請" : "# 🎁 贈送邀請")
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(offerLines(offer, itemDef))
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏳ 請在 <t:${expiresEpoch(offer)}:R> 前決定，逾時自動退回對方。`
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${ACCEPT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
          .setLabel("收下")
          .setEmoji("✅")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${REJECT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
          .setLabel("拒收")
          .setEmoji("✋")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${CANCEL_PREFIX}${offer.sender_id}_${offer.offer_id}`)
          .setLabel("寄件方取消")
          .setStyle(ButtonStyle.Secondary)
      )
    );
  return container;
}

// 結算後的定版訊息（無按鈕）。
function buildSettledContainer({ color, title, body, extraLines = [], channelRow }) {
  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${title}`));
  if (body) {
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }
  for (const line of extraLines) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
  }
  if (channelRow) container.addActionRowComponents(channelRow);
  return container;
}

// 收下成功訊息
function buildAcceptedContainer(result) {
  const offer = result.offer;
  if (result.kind === "coin") {
    return buildSettledContainer({
      color: SUCCESS_COLOR,
      title: "✅ 已收下轉帳",
      body:
        `<@${offer.recipient_id}> 收下了 <@${offer.sender_id}> 的 **${offer.amount.toLocaleString()}** ${MONEY_EMOJI}` +
        (offer.note ? `\n📝 備註：${offer.note}` : ""),
    });
  }
  const def = result.itemDef || {};
  const lines = [];
  if (result.overflowQty > 0) {
    lines.push(
      result.deliveredQty > 0
        ? `🎒 背包只放得下 **${result.deliveredQty}** 個，其餘 **${result.overflowQty}** 折成 **+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI} 入帳。`
        : `🎒 背包已滿，全部折成 **+${result.overflowCoins.toLocaleString()}** ${COIN_EMOJI} 入帳。`
    );
  }
  return buildSettledContainer({
    color: SUCCESS_COLOR,
    title: "✅ 已收下禮物",
    body: `<@${offer.recipient_id}> 收下了 <@${offer.sender_id}> 送的 **${def.emoji || ""} ${def.name || offer.item.key} ×${offer.item.qty}**！`,
    extraLines: lines,
  });
}

// 拒收 / 取消 / 逾時的定版訊息
function buildRefundContainer(offer, kindOfEnd) {
  const titleMap = {
    rejected: "✋ 已拒收",
    cancelled: "↩️ 寄件方已取消",
    expired: "⌛ 逾時未收，已退回",
  };
  const what =
    offer.kind === "coin"
      ? `**${offer.amount.toLocaleString()}** ${MONEY_EMOJI}（含手續費 ${offer.fee.toLocaleString()}）`
      : `禮物`;
  return buildSettledContainer({
    color: REFUND_COLOR,
    title: titleMap[kindOfEnd] || "已退回",
    body: `${what} 已全數退回 <@${offer.sender_id}>。`,
  });
}

module.exports = {
  ACCEPT_PREFIX,
  REJECT_PREFIX,
  CANCEL_PREFIX,
  COIN_COLOR,
  ITEM_COLOR,
  FAIL_COLOR,
  buildOfferContainer,
  buildSettledContainer,
  buildAcceptedContainer,
  buildRefundContainer,
};
