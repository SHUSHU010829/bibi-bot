const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { mining } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");

// customId 前綴常數（與 handleMarketInteraction 共用）
const BUY_PREFIX      = "market_buy_";
const ACCEPT_PREFIX   = "market_accept_";
const FULFILL_PREFIX  = "market_fulfill_";
const BID_PREFIX      = "market_bid_";
const CANCEL_PREFIX   = "market_cancel_";
const CONFIRM_BUY     = "market_confirm_buy_";
const CONFIRM_ACCEPT  = "market_confirm_accept_";
const CONFIRM_FULFILL = "market_confirm_fulfill_";
const CONFIRM_CANCEL  = "market_confirm_cancel_";
const ABORT_ID        = "market_abort";
const PAGE_PREV       = "market_page_prev_";
const PAGE_NEXT       = "market_page_next_";

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey}`;
}

function typeLabel(type) {
  const map = { sell: "賣礦", barter: "換礦", want: "徵求", auction: "競標" };
  return map[type] || type;
}

function typeBadge(type) {
  const map = { sell: "💰", barter: "🔄", want: "📋", auction: "🏷️" };
  return map[type] || "📦";
}

// 組單筆掛單的文字敘述
function listingText(l) {
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const badge = typeBadge(l.listing_type);
  const header = `**${badge} #${l.listing_id} ・ ${typeLabel(l.listing_type)}**`;

  if (l.listing_type === "sell") {
    return (
      `${header}\n` +
      `${oreLabel(l.ore)} ×${l.qty}　💰 **${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
      `賣家：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "barter") {
    return (
      `${header}\n` +
      `${oreLabel(l.ore)} ×${l.qty} 換 ${oreLabel(l.want_ore)} ×${l.want_qty}\n` +
      `掛單：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "want") {
    const payStr = l.pay_kind === "coin"
      ? `**${l.pay_coin.toLocaleString()}** ${COIN_EMOJI}`
      : `${oreLabel(l.pay_ore)} ×${l.pay_qty}`;
    return (
      `${header}\n` +
      `徵求 ${oreLabel(l.ore)} ×${l.qty}　付 ${payStr}\n` +
      `發單：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "auction") {
    const bidLine = l.current_bid
      ? `目前最高：**${l.current_bid.toLocaleString()}** ${COIN_EMOJI}（${l.bidder_name || "匿名"}）`
      : `起標：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}（尚無人出價）`;
    const buyoutLine = l.buyout_price
      ? `　💰 一口價 **${l.buyout_price.toLocaleString()}** ${COIN_EMOJI}` : "";
    return (
      `${header}\n` +
      `${oreLabel(l.ore)} ×${l.qty}\n` +
      `${bidLine}${buyoutLine}\n` +
      `賣家：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  return header;
}

// 組單筆掛單對應的操作按鈕（作為 Section 右側配件，與該筆掛單同排）
function listingAccessoryButton(l, viewerIsSeller = false) {
  if (viewerIsSeller) {
    // 我的攤位：只顯示下架鈕
    return new ButtonBuilder()
      .setCustomId(`${CANCEL_PREFIX}${l.listing_id}`)
      .setLabel("下架")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger);
  }

  if (l.listing_type === "sell") {
    return new ButtonBuilder()
      .setCustomId(`${BUY_PREFIX}${l.listing_id}`)
      .setLabel("購買")
      .setEmoji("💰")
      .setStyle(ButtonStyle.Success);
  }
  if (l.listing_type === "barter") {
    return new ButtonBuilder()
      .setCustomId(`${ACCEPT_PREFIX}${l.listing_id}`)
      .setLabel("接受交換")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Primary);
  }
  if (l.listing_type === "want") {
    return new ButtonBuilder()
      .setCustomId(`${FULFILL_PREFIX}${l.listing_id}`)
      .setLabel("賣給他")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary);
  }
  if (l.listing_type === "auction") {
    return new ButtonBuilder()
      .setCustomId(`${BID_PREFIX}${l.listing_id}`)
      .setLabel("出價")
      .setEmoji("🏷️")
      .setStyle(ButtonStyle.Primary);
  }
  return null;
}

// ─── 逛攤清單 ─────────────────────────────────────────────────────────────────
function buildBrowseView(listings, total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const container = new ContainerBuilder()
    .setAccentColor(0xe1b12c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏪 市集\n` +
        (total === 0
          ? "目前沒有任何掛單，用 `/市集 賣礦`、`/市集 換礦`、`/市集 徵求` 或 `/市集 競標` 來掛牌吧！"
          : `共 **${total}** 筆掛單・第 ${page + 1} / ${totalPages} 頁`)
      )
    );

  if (listings.length === 0) {
    return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
  );

  // 每筆掛單一個區塊：左側敘述 + 右側操作鈕（同排），區塊之間以分隔線分開
  listings.forEach((l, idx) => {
    const btn = listingAccessoryButton(l, false);
    if (btn) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(listingText(l)))
          .setButtonAccessory(btn)
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(listingText(l))
      );
    }
    if (idx < listings.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }
  });

  // 翻頁按鈕（放進 Container 底部）
  if (totalPages > 1) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
    );
    const pageRow = new ActionRowBuilder();
    if (page > 0) {
      pageRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`${PAGE_PREV}${page - 1}`)
          .setLabel("◀ 上一頁")
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (page + 1 < totalPages) {
      pageRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`${PAGE_NEXT}${page + 1}`)
          .setLabel("下一頁 ▶")
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (pageRow.components.length > 0) container.addActionRowComponents(pageRow);
  }

  return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
}

// ─── 我的攤位 ─────────────────────────────────────────────────────────────────
function buildMyStallView(listings) {
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        listings.length === 0
          ? "# 🏪 我的攤位\n目前沒有掛單，去用 `/市集` 指令掛一筆吧！"
          : `# 🏪 我的攤位\n共 **${listings.length}** 筆 active 掛單`
      )
    );

  if (listings.length === 0) {
    return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
  );
  // 每筆掛單一個區塊：左側敘述 + 右側下架鈕（同排），區塊之間以分隔線分開
  listings.forEach((l, idx) => {
    const btn = listingAccessoryButton(l, true);
    if (btn) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(listingText(l)))
          .setButtonAccessory(btn)
      );
    } else {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(listingText(l))
      );
    }
    if (idx < listings.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }
  });
  return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
}

// ─── 二次確認面板（ephemeral）────────────────────────────────────────────────
function buildConfirmView(listing, action) {
  let content = "";

  if (action === "buy") {
    content =
      `## 確認購買？\n` +
      `**#${listing.listing_id}** ${oreLabel(listing.ore)} ×${listing.qty}\n` +
      `💰 **${listing.price.toLocaleString()}** ${COIN_EMOJI} 將從你的帳戶扣除（成交後不退）`;
  } else if (action === "accept") {
    content =
      `## 確認接受換礦？\n` +
      `**#${listing.listing_id}** 你給出 ${oreLabel(listing.want_ore)} ×${listing.want_qty}\n` +
      `換取 ${oreLabel(listing.ore)} ×${listing.qty}`;
  } else if (action === "fulfill") {
    const payStr = listing.pay_kind === "coin"
      ? `**${listing.pay_coin.toLocaleString()}** ${COIN_EMOJI}`
      : `${oreLabel(listing.pay_ore)} ×${listing.pay_qty}`;
    content =
      `## 確認賣礦？\n` +
      `**#${listing.listing_id}** 你給出 ${oreLabel(listing.ore)} ×${listing.qty}\n` +
      `收取 ${payStr}`;
  } else if (action === "cancel") {
    content =
      `## 確認下架？\n` +
      `**#${listing.listing_id}** ${listingText(listing).split("\n")[1] || ""}\n` +
      `-# 託管的礦石／金幣將退回你的帳戶`;
  }

  const confirmPrefix = {
    buy: CONFIRM_BUY,
    accept: CONFIRM_ACCEPT,
    fulfill: CONFIRM_FULFILL,
    cancel: CONFIRM_CANCEL,
  }[action] || "market_confirm_";

  const container = new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${confirmPrefix}${listing.listing_id}`)
      .setLabel("✅ 確定")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(ABORT_ID)
      .setLabel("❌ 取消")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    container,
    row,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

// ─── 競標出價 modal ───────────────────────────────────────────────────────────
const BID_MODAL_PREFIX = "market_bidmodal_";

function buildBidModal(listingId, listing) {
  const modal = new ModalBuilder()
    .setCustomId(`${BID_MODAL_PREFIX}${listingId}`)
    .setTitle(`對 #${listingId} 競標`);
  const input = new TextInputBuilder()
    .setCustomId("bid_amount")
    .setLabel(`出價金額（${COIN_EMOJI}）`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(12)
    .setPlaceholder(
      listing?.buyout_price
        ? `最低 ${listing.current_bid ? listing.current_bid + 1 : listing.start_price}，一口價 ${listing.buyout_price}`
        : `最低 ${listing?.current_bid ? listing.current_bid + 1 : listing?.start_price || 1}`
    );
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

module.exports = {
  buildBrowseView,
  buildMyStallView,
  buildConfirmView,
  buildBidModal,
  oreLabel,
  listingText,
  // customId 前綴常數（handler 共用）
  BUY_PREFIX,
  ACCEPT_PREFIX,
  FULFILL_PREFIX,
  BID_PREFIX,
  CANCEL_PREFIX,
  CONFIRM_BUY,
  CONFIRM_ACCEPT,
  CONFIRM_FULFILL,
  CONFIRM_CANCEL,
  ABORT_ID,
  PAGE_PREV,
  PAGE_NEXT,
  BID_MODAL_PREFIX,
};
