const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { MONEY_EMOJI, COIN_EMOJI } = require("../../constants/coin");
const { offerLabel } = require("../mining/giftService");

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

function offerLines(offer) {
  if (offer.kind === "coin") {
    const lines = [
      `<@${offer.sender_id}> 想轉給你 **${offer.amount.toLocaleString()}** ${MONEY_EMOJI}`,
    ];
    if (offer.note) lines.push(`📝 備註：${offer.note}`);
    lines.push(`-# 手續費 ${offer.fee.toLocaleString()} 已由對方預付，拒收 / 逾時會全額退回對方。`);
    return lines.join("\n");
  }
  return (
    `<@${offer.sender_id}> 想送你 **${offerLabel(offer.item)} ×${offer.item.qty}**\n` +
    `-# 收下後若背包放不下（僅礦石占格數），多的會折成 ${COIN_EMOJI} 入帳。`
  );
}

// 待收邀請訊息。DM 給收款人時 includeCancel=false（寄件方不在場，改用 /待收 取消）；
// 頻道退回情境 includeCancel=true 讓寄件方能就地取消。
function buildOfferContainer(offer, { includeCancel = false, guildName } = {}) {
  const isCoin = offer.kind === "coin";
  const container = new ContainerBuilder()
    .setAccentColor(isCoin ? COIN_COLOR : ITEM_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`<@${offer.recipient_id}>`)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        (isCoin ? "# 💸 轉帳邀請" : "# 🎁 贈送邀請") + (guildName ? `\n-# 來自：${guildName}` : "")
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(offerLines(offer))
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `⏳ 請在 <t:${expiresEpoch(offer)}:R> 前決定，逾時自動退回對方。`
      )
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ACCEPT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
      .setLabel("收下")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${REJECT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
      .setLabel("拒收")
      .setEmoji("✋")
      .setStyle(ButtonStyle.Danger)
  );
  if (includeCancel) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${CANCEL_PREFIX}${offer.sender_id}_${offer.offer_id}`)
        .setLabel("寄件方取消")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  container.addActionRowComponents(row);
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
    body: `<@${offer.recipient_id}> 收下了 <@${offer.sender_id}> 送的 **${offerLabel(offer.item)} ×${offer.item.qty}**！`,
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

// offer 內容一句話摘要（給提醒 / 清單用）
function summaryOf(offer) {
  if (offer.kind === "coin") {
    return `${offer.amount.toLocaleString()} ${MONEY_EMOJI}（含手續費 ${offer.fee.toLocaleString()}）`;
  }
  return `${offerLabel(offer.item)} ×${offer.item.qty}`;
}

const STATUS_LIST_LIMIT = 4;

// /待收 清單：我要收的（收下/拒收）＋ 我送出的（狀態/取消）。
function buildStatusContainer({ incoming = [], outgoing = [] }) {
  const container = new ContainerBuilder()
    .setAccentColor(COIN_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# 📮 待收清單"));

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📥 我要收的"));
  if (incoming.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 目前沒有要收的。"));
  } else {
    for (const offer of incoming.slice(0, STATUS_LIST_LIMIT)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${offer.kind === "coin" ? "💸" : "🎁"} 來自 <@${offer.sender_id}>：**${summaryOf(offer)}**\n-# <t:${expiresEpoch(offer)}:R> 到期`
        )
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${ACCEPT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
            .setLabel("收下").setEmoji("✅").setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`${REJECT_PREFIX}${offer.recipient_id}_${offer.offer_id}`)
            .setLabel("拒收").setEmoji("✋").setStyle(ButtonStyle.Danger)
        )
      );
    }
    if (incoming.length > STATUS_LIST_LIMIT) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 還有 ${incoming.length - STATUS_LIST_LIMIT} 筆未顯示。`));
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder());
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent("## 📤 我送出的（等待對方收下）"));
  if (outgoing.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent("-# 目前沒有送出待收的。"));
  } else {
    for (const offer of outgoing.slice(0, STATUS_LIST_LIMIT)) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `${offer.kind === "coin" ? "💸" : "🎁"} 給 <@${offer.recipient_id}>：**${summaryOf(offer)}** — ⏳ 等待中\n-# <t:${expiresEpoch(offer)}:R> 到期`
        )
      );
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${CANCEL_PREFIX}${offer.sender_id}_${offer.offer_id}`)
            .setLabel("取消並取回").setEmoji("↩️").setStyle(ButtonStyle.Secondary)
        )
      );
    }
    if (outgoing.length > STATUS_LIST_LIMIT) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# 還有 ${outgoing.length - STATUS_LIST_LIMIT} 筆未顯示。`));
    }
  }
  return container;
}

module.exports = {
  ACCEPT_PREFIX,
  REJECT_PREFIX,
  CANCEL_PREFIX,
  COIN_COLOR,
  ITEM_COLOR,
  FAIL_COLOR,
  summaryOf,
  buildOfferContainer,
  buildSettledContainer,
  buildAcceptedContainer,
  buildRefundContainer,
  buildStatusContainer,
};
