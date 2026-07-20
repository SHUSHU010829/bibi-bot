const {
  ContainerBuilder,
  TextDisplayBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { mining, fishing, farming, guildWarehouse } = require("../../config");
const { COIN_EMOJI } = require("../../constants/coin");
const itemAccess = require("./itemAccess");

// 與 marketplaceService.resolveListingItem 同邏輯，這裡 inline 以避免循環依賴
function resolveListingItem(listing) {
  if (!listing) return null;
  if (listing.item_type === "fish" || listing.fish_key) {
    return { item_type: "fish", item_key: listing.fish_key || listing.item_key };
  }
  if (listing.item_type === "veggie" || listing.veggie_key) {
    return { item_type: "veggie", item_key: listing.veggie_key || listing.item_key };
  }
  return { item_type: "ore", item_key: listing.ore || listing.item_key };
}

function resolveListingPayItem(listing) {
  if (!listing) return null;
  if (listing.pay_item_type) {
    return { item_type: listing.pay_item_type, item_key: listing.pay_item_key, qty: listing.pay_qty };
  }
  if (listing.pay_ore) {
    return { item_type: "ore", item_key: listing.pay_ore, qty: listing.pay_qty };
  }
  return null;
}

// customId 前綴常數（與 handleMarketInteraction 共用）
const BUY_PREFIX      = "market_buy_";
const ACCEPT_PREFIX   = "market_accept_";
const FULFILL_PREFIX  = "market_fulfill_";
const BID_PREFIX      = "market_bid_";
// 收購：賣給他 → 預覽面板 → 一鍵賣出 / 自訂數量
const BULK_SELL_PREFIX    = "market_bulksell_";
const BULK_CONFIRM_PREFIX = "market_bulkconfirm_";
const BULK_CUSTOM_PREFIX  = "market_bulkcustom_";
const BULK_MODAL_PREFIX   = "market_bulkmodal_";
// 賣單（賣單）：購買 → 預覽面板 → 一鍵買入 / 自訂數量
const BULKSELL_BUY_PREFIX     = "market_bsbuy_";
const BULKSELL_CONFIRM_PREFIX = "market_bsconfirm_";
const BULKSELL_CUSTOM_PREFIX  = "market_bscustom_";
const BULKSELL_MODAL_PREFIX   = "market_bsmodal_";
// 物物交換（swap）：賣給他 → 預覽面板 → 一鍵換出 / 自訂數量
const SWAP_SELL_PREFIX    = "market_swapsell_";
const SWAP_CONFIRM_PREFIX = "market_swapconfirm_";
const SWAP_CUSTOM_PREFIX  = "market_swapcustom_";
const SWAP_MODAL_PREFIX   = "market_swapmodal_";
// 續租：market_renew_<ownerId>_<listingId>_<days>
const RENEW_PREFIX = "market_renew_";
// CANCEL 格式：market_cancel_<sellerId>_<listingId>（owner 驗證在 handler，渲染時也只給賣家看）
const CANCEL_PREFIX   = "market_cancel_";
const CONFIRM_BUY     = "market_confirm_buy_";
const CONFIRM_ACCEPT  = "market_confirm_accept_";
const CONFIRM_FULFILL = "market_confirm_fulfill_";
const CONFIRM_CANCEL  = "market_confirm_cancel_";
const ABORT_ID        = "market_abort";
const PAGE_PREV       = "market_page_prev_";
const PAGE_NEXT       = "market_page_next_";
const REFRESH_ID      = "market_refresh_";
const VIEW_BROWSE_ID  = "market_view_browse";
const VIEW_MYSTALL_ID = "market_view_mystall";
const VIEW_MYBIDS_ID  = "market_view_mybids";
const VIEW_BARTER_ID  = "market_view_barter";

function oreLabel(oreKey) {
  const def = mining?.ores?.[oreKey] || {};
  return `${def.emoji || "⛏️"} ${def.name || oreKey || "未知物品"}`;
}

// 統一 item 顯示：依 item_type 決定礦石/魚/農產品
function itemLabel(listing) {
  if (listing.listing_type === "guild_sell") {
    const def = guildWarehouse?.items?.[listing.item_id] || {};
    return `${def.emoji || "📦"} ${def.name || listing.item_id || "未知物品"}`;
  }
  const item = resolveListingItem(listing);
  return itemAccess.itemLabel(item.item_type, item.item_key);
}

// 市集篩選器 customId 前綴
const FILTER_TYPE_ID = "market_filter_type";
const FILTER_ITEM_ID = "market_filter_item";

function typeLabel(type) {
  const map = {
    sell: "賣出",
    barter: "換物",
    want: "徵求",
    auction: "競標",
    guild_sell: "公會寄售",
    bulk: "收購",
    bulk_sell: "賣單",
    swap: "物物交換",
  };
  return map[type] || type;
}

function typeBadge(type) {
  const map = {
    sell: "💰",
    barter: "🔄",
    want: "📋",
    auction: "🏷️",
    guild_sell: "🏰",
    bulk: "🛒",
    bulk_sell: "📦",
    swap: "🔄",
  };
  return map[type] || "📦";
}

// 收購進度條：▰ 已收 / ▱ 未收（固定 10 格）
function progressBar(filled, total) {
  const t = Math.max(1, total);
  const ratio = Math.max(0, Math.min(1, filled / t));
  const done = Math.round(ratio * 10);
  return "▰".repeat(done) + "▱".repeat(10 - done);
}

// 組單筆掛單的文字敘述
function listingText(l) {
  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const badge = typeBadge(l.listing_type);
  const titleLine = l.title ? `📌 ${l.title}\n` : "";
  const header = `${titleLine}**${badge} #${l.listing_id} ・ ${typeLabel(l.listing_type)}**`;

  if (l.listing_type === "sell") {
    return (
      `${header}\n` +
      `${itemLabel(l)} ×${l.qty}　💰 **${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
      `賣家：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "guild_sell") {
    return (
      `${header}\n` +
      `${itemLabel(l)} ×${l.qty}　💰 **${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
      `🏰 ${l.guild_club_name || "公會"}（上架：${l.seller_name || "?"}）　截止 <t:${expiresEpoch}:R>\n` +
      `-# 收益全額進公會金庫`
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
    const wantItem = resolveListingItem(l);
    const payItem = resolveListingPayItem(l);
    const wantStr = itemAccess.itemLabel(wantItem.item_type, wantItem.item_key, l.qty);
    const payStr = payItem
      ? itemAccess.itemLabel(payItem.item_type, payItem.item_key, payItem.qty)
      : `**${l.pay_coin.toLocaleString()}** ${COIN_EMOJI}`;
    return (
      `${header}\n` +
      `徵求 ${wantStr}　付 ${payStr}\n` +
      `發單：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "bulk") {
    const item = resolveListingItem(l);
    const filled = l.filled_qty || 0;
    const remaining = Math.max(0, l.qty - filled);
    return (
      `${header}\n` +
      `收購 ${itemAccess.itemLabel(item.item_type, item.item_key)}　每個 **${(l.unit_price || 0).toLocaleString()}** ${COIN_EMOJI}\n` +
      `${progressBar(filled, l.qty)} **${filled.toLocaleString()} / ${l.qty.toLocaleString()}**（尚缺 ${remaining.toLocaleString()}）\n` +
      `發單：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "bulk_sell") {
    const item = resolveListingItem(l);
    const filled = l.filled_qty || 0;
    const remaining = Math.max(0, l.qty - filled);
    return (
      `${header}\n` +
      `出售 ${itemAccess.itemLabel(item.item_type, item.item_key)}　每個 **${(l.unit_price || 0).toLocaleString()}** ${COIN_EMOJI}\n` +
      `${progressBar(filled, l.qty)} **${filled.toLocaleString()} / ${l.qty.toLocaleString()}**（尚餘 ${remaining.toLocaleString()}）\n` +
      `賣家：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "swap") {
    const give = l.give || {};
    const want = l.want || {};
    const filled = l.filled_qty || 0;
    const wantTotal = want.qty || 0;
    const remaining = Math.max(0, wantTotal - filled);
    const giveLabel = itemAccess.itemLabel(give.type, give.key);
    const wantLabel = itemAccess.itemLabel(want.type, want.key);
    return (
      `${header}\n` +
      `收 ${wantLabel} ×${wantTotal.toLocaleString()}　付 ${giveLabel} ×${(give.qty || 0).toLocaleString()}\n` +
      `${progressBar(filled, wantTotal)} **${filled.toLocaleString()} / ${wantTotal.toLocaleString()}**（尚缺 ${remaining.toLocaleString()}）\n` +
      `發單：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  if (l.listing_type === "auction") {
    const item = resolveListingItem(l);
    const bidLine = l.current_bid
      ? `目前最高：**${l.current_bid.toLocaleString()}** ${COIN_EMOJI}（${l.bidder_name || "匿名"}）`
      : `起標：**${l.start_price.toLocaleString()}** ${COIN_EMOJI}（尚無人出價）`;
    const buyoutLine = l.buyout_price
      ? `　💰 一口價 **${l.buyout_price.toLocaleString()}** ${COIN_EMOJI}` : "";
    return (
      `${header}\n` +
      `${itemAccess.itemLabel(item.item_type, item.item_key, l.qty)}\n` +
      `${bidLine}${buyoutLine}\n` +
      `賣家：${l.seller_name || "?"}　截止 <t:${expiresEpoch}:R>`
    );
  }
  return header;
}

// 組單筆掛單對應的操作按鈕（作為 Section 右側配件，與該筆掛單同排）
function listingAccessoryButton(l, viewerIsSeller = false) {
  if (viewerIsSeller) {
    // 賣家自己看到的攤位：只顯示下架鈕，customId 嵌入 sellerId 供 handler 驗證
    return new ButtonBuilder()
      .setCustomId(`${CANCEL_PREFIX}${l.seller_id}_${l.listing_id}`)
      .setLabel("下架")
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger);
  }

  if (l.listing_type === "sell" || l.listing_type === "guild_sell") {
    return new ButtonBuilder()
      .setCustomId(`${BUY_PREFIX}${l.listing_id}`)
      .setLabel("購買")
      .setEmoji(l.listing_type === "guild_sell" ? "🏰" : "💰")
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
  if (l.listing_type === "bulk") {
    return new ButtonBuilder()
      .setCustomId(`${BULK_SELL_PREFIX}${l.listing_id}`)
      .setLabel("賣給他")
      .setEmoji("🛒")
      .setStyle(ButtonStyle.Primary);
  }
  if (l.listing_type === "bulk_sell") {
    return new ButtonBuilder()
      .setCustomId(`${BULKSELL_BUY_PREFIX}${l.listing_id}`)
      .setLabel("購買")
      .setEmoji("📦")
      .setStyle(ButtonStyle.Success);
  }
  if (l.listing_type === "swap") {
    return new ButtonBuilder()
      .setCustomId(`${SWAP_SELL_PREFIX}${l.listing_id}`)
      .setLabel("賣給他")
      .setEmoji("🔄")
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

// 把 filter 狀態編碼進翻頁 customId，格式：<prefix><page>:<listingType>:<itemType>
// 例：market_page_next_2:sell:fish
function encodePageId(prefix, page, { listingType = "all", itemType = "all" } = {}) {
  return `${prefix}${page}:${listingType}:${itemType}`;
}

// ─── 逛攤清單 ─────────────────────────────────────────────────────────────────
// filters: { listingType: "all"|"sell"|"barter"|"want"|"auction", itemType: "all"|"ore"|"fish" }
// viewerId：用來判斷某筆掛單是否屬於觀看者，是的話按鈕改顯示下架（owner gating at render time）
function buildBrowseView(listings, total, page, pageSize, filters = {}, viewerId = null) {
  const { listingType = "all", itemType = "all" } = filters;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const container = new ContainerBuilder()
    .setAccentColor(0xe1b12c)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🏪 市集\n` +
        (total === 0
          ? "目前沒有符合條件的掛單。"
          : `共 **${total}** 筆掛單・第 ${page + 1} / ${totalPages} 頁`)
      )
    );

  // ── 篩選器 ──
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(FILTER_TYPE_ID)
        .setPlaceholder("📋 交易類型篩選")
        .addOptions([
          { label: "全部類型",    value: "all",        default: listingType === "all" },
          { label: "🛒 收購", value: "bulk",       default: listingType === "bulk" },
          { label: "📦 賣單", value: "bulk_sell",  default: listingType === "bulk_sell" },
          { label: "🔄 物物交換", value: "swap",       default: listingType === "swap" },
          { label: "🏷️ 競標",    value: "auction",    default: listingType === "auction" },
          { label: "🏰 公會寄售", value: "guild_sell", default: listingType === "guild_sell" },
        ])
    )
  );
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(FILTER_ITEM_ID)
        .setPlaceholder("📦 物品類別篩選")
        .addOptions([
          { label: "全部物品", value: "all",    default: itemType === "all" },
          { label: "⛏️ 礦石",  value: "ore",    default: itemType === "ore" },
          { label: "🐟 魚類",  value: "fish",   default: itemType === "fish" },
          { label: "🌾 作物",  value: "veggie", default: itemType === "veggie" },
        ])
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
    const viewerIsSeller = !!viewerId && l.seller_id === viewerId;
    const btn = listingAccessoryButton(l, viewerIsSeller);
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

  // 底部控制列：翻頁 + 重整（customId 包含當前 filter/頁碼狀態）
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
  );
  const pageRow = new ActionRowBuilder();
  if (totalPages > 1 && page > 0) {
    pageRow.addComponents(
      new ButtonBuilder()
        .setCustomId(encodePageId(PAGE_PREV, page - 1, { listingType, itemType }))
        .setLabel("◀ 上一頁")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  pageRow.addComponents(
    new ButtonBuilder()
      .setCustomId(encodePageId(REFRESH_ID, page, { listingType, itemType }))
      .setLabel("重整")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary)
  );
  if (totalPages > 1 && page + 1 < totalPages) {
    pageRow.addComponents(
      new ButtonBuilder()
        .setCustomId(encodePageId(PAGE_NEXT, page + 1, { listingType, itemType }))
        .setLabel("下一頁 ▶")
        .setStyle(ButtonStyle.Secondary)
    );
  }
  container.addActionRowComponents(pageRow);

  return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
}

// ─── 公開掛單卡（可隨成交進度即時更新）─────────────────────────────────────────
// 給頻道其他玩家看目前兜售/收購進度：成交、收滿、下架、到期時就地更新這張卡。
function buildLiveListingCard(l) {
  const active = l.status === "active";
  let statusTag = "";
  if (l.status === "sold") {
    statusTag = l.listing_type === "bulk" ? "✅ 已收滿" : l.listing_type === "swap" ? "✅ 已換滿" : "✅ 已售完";
  } else if (l.status === "expired") {
    statusTag = "⌛ 已到期";
  } else if (l.status === "cancelled") {
    statusTag = "🗑️ 已下架";
  } else if (l.status === "settling") {
    statusTag = "⏳ 結算中";
  }

  const container = new ContainerBuilder().setAccentColor(active ? 0x2980b9 : 0x95a5a6);
  const body = listingText(l) + (statusTag ? `\n**${statusTag}**` : "");
  const btn = active ? listingAccessoryButton(l, false) : null;
  if (btn) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .setButtonAccessory(btn)
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  }
  return container;
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

// ─── 我的競標：我目前是最高出價者的競標 listing ─────────────────────────────
function buildMyBidsView(listings) {
  const container = new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        listings.length === 0
          ? "# 🏷️ 我的競標\n你目前不是任何競標的最高出價者。\n-# 用 `/市集 逛攤` 找競標品。"
          : `# 🏷️ 我的競標\n共 **${listings.length}** 件正領先中`
      )
    );

  if (listings.length === 0) {
    return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
  }

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large)
  );

  listings.forEach((l, idx) => {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(listingText(l))
    );
    if (idx < listings.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
      );
    }
  });

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "-# 若被超越會自動退款並私訊通知；到期最高者得標。"
    )
  );
  return { container, rows: [], flags: MessageFlags.IsComponentsV2 };
}

// ─── 二次確認面板（ephemeral）────────────────────────────────────────────────
function buildConfirmView(listing, action) {
  let content = "";

  if (action === "buy") {
    const guildLine =
      listing.listing_type === "guild_sell"
        ? `\n🏰 來自 ${listing.guild_club_name || "公會"}（收益全額進公會金庫）`
        : "";
    content =
      `## 確認購買？\n` +
      `**#${listing.listing_id}** ${itemLabel(listing)} ×${listing.qty}${guildLine}\n` +
      `💰 **${listing.price.toLocaleString()}** ${COIN_EMOJI} 將從你的帳戶扣除（成交後不退）`;
  } else if (action === "accept") {
    content =
      `## 確認接受換礦？\n` +
      `**#${listing.listing_id}** 你給出 ${oreLabel(listing.want_ore)} ×${listing.want_qty}\n` +
      `換取 ${oreLabel(listing.ore)} ×${listing.qty}`;
  } else if (action === "fulfill") {
    const wantItem = resolveListingItem(listing);
    const payItem = resolveListingPayItem(listing);
    const payStr = payItem
      ? itemAccess.itemLabel(payItem.item_type, payItem.item_key, payItem.qty)
      : `**${listing.pay_coin.toLocaleString()}** ${COIN_EMOJI}`;
    content =
      `## 確認賣出？\n` +
      `**#${listing.listing_id}** 你給出 ${itemAccess.itemLabel(wantItem.item_type, wantItem.item_key, listing.qty)}\n` +
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
    .setLabel("出價金額（🪙）")
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

// ─── 收購：賣出預覽面板（ephemeral）──────────────────────────────────────
// preview: { listing, item, have, remaining, sellable }
function buildBulkFulfillView(preview) {
  const { listing: l, item, have, remaining, sellable } = preview;
  const unit = l.unit_price || 0;
  const filled = l.filled_qty || 0;
  const itemName = itemAccess.itemLabel(item.item_type, item.item_key);
  const payout = sellable * unit;

  const container = new ContainerBuilder().setAccentColor(0x16a085);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🛒 賣給收購單 **#${l.listing_id}**\n` +
        `收購 ${itemName}　每個 **${unit.toLocaleString()}** ${COIN_EMOJI}\n` +
        `${progressBar(filled, l.qty)} **${filled.toLocaleString()} / ${l.qty.toLocaleString()}**（尚缺 ${remaining.toLocaleString()}）`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `你持有 ${itemName} ×**${have.toLocaleString()}**\n` +
        `一鍵賣出 **${sellable.toLocaleString()}** 個 → +**${payout.toLocaleString()}** ${COIN_EMOJI}\n` +
        `-# 想留一些可按「自訂數量」。`
    )
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULK_CONFIRM_PREFIX}${l.listing_id}`)
      .setLabel(`賣出 ${sellable.toLocaleString()}（+${payout.toLocaleString()}）`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BULK_CUSTOM_PREFIX}${l.listing_id}`)
      .setLabel("自訂數量")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ABORT_ID)
      .setLabel("取消")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    container,
    row,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

function buildBulkQtyModal(listingId, sellable) {
  const modal = new ModalBuilder()
    .setCustomId(`${BULK_MODAL_PREFIX}${listingId}`)
    .setTitle(`賣給 #${listingId}`);
  const input = new TextInputBuilder()
    .setCustomId("bulk_qty")
    .setLabel("要賣出的數量")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(9)
    .setPlaceholder(`最多可賣 ${sellable}`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ─── 賣單：買入預覽面板（ephemeral）──────────────────────────────────────
// preview: { listing, item, unit, remaining, balance, affordable, capRoom, buyable }
function buildBulkSellBuyView(preview) {
  const { listing: l, item, unit, remaining, balance, buyable } = preview;
  const filled = l.filled_qty || 0;
  const itemName = itemAccess.itemLabel(item.item_type, item.item_key);
  const cost = buyable * unit;

  const container = new ContainerBuilder().setAccentColor(0x2980b9);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 📦 向賣單單 **#${l.listing_id}** 購買\n` +
        `出售 ${itemName}　每個 **${unit.toLocaleString()}** ${COIN_EMOJI}\n` +
        `${progressBar(filled, l.qty)} **${filled.toLocaleString()} / ${l.qty.toLocaleString()}**（尚餘 ${remaining.toLocaleString()}）`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `你的餘額 **${balance.toLocaleString()}** ${COIN_EMOJI}\n` +
        `一鍵買入 **${buyable.toLocaleString()}** 個 → −**${cost.toLocaleString()}** ${COIN_EMOJI}\n` +
        `-# 想少買一些可按「自訂數量」。礦石背包放不下會自動進信箱。`
    )
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BULKSELL_CONFIRM_PREFIX}${l.listing_id}`)
      .setLabel(`買入 ${buyable.toLocaleString()}（−${cost.toLocaleString()}）`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BULKSELL_CUSTOM_PREFIX}${l.listing_id}`)
      .setLabel("自訂數量")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ABORT_ID)
      .setLabel("取消")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    container,
    row,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

function buildBulkSellQtyModal(listingId, buyable) {
  const modal = new ModalBuilder()
    .setCustomId(`${BULKSELL_MODAL_PREFIX}${listingId}`)
    .setTitle(`向 #${listingId} 購買`);
  const input = new TextInputBuilder()
    .setCustomId("bulk_qty")
    .setLabel("要買入的數量")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(9)
    .setPlaceholder(`最多可買 ${buyable}`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

// ─── 物物交換：交出預覽面板（ephemeral）──────────────────────────────────────
// preview: { listing, give, want, haveWant, remainingWant, sellable, giveForSellable, filledWant }
function buildSwapFulfillView(preview) {
  const { listing: l, give, want, haveWant, remainingWant, sellable, giveForSellable, filledWant } = preview;
  const wantName = itemAccess.itemLabel(want.type, want.key);
  const giveName = itemAccess.itemLabel(give.type, give.key);

  const container = new ContainerBuilder().setAccentColor(0x9b59b6);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🔄 賣給物物交換單 **#${l.listing_id}**\n` +
        `對方收 ${wantName}，付 ${giveName}（總量 ${give.qty.toLocaleString()} 換 ${want.qty.toLocaleString()}）\n` +
        `${progressBar(filledWant, want.qty)} **${filledWant.toLocaleString()} / ${want.qty.toLocaleString()}**（尚缺 ${remainingWant.toLocaleString()}）`
    )
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `你持有 ${wantName} ×**${haveWant.toLocaleString()}**\n` +
        `一鍵交出 **${sellable.toLocaleString()}** 個 → 領 ${giveName} ×**${giveForSellable.toLocaleString()}**\n` +
        `-# 依比例撥付，交越多領越多；礦石放不下會自動進信箱。`
    )
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SWAP_CONFIRM_PREFIX}${l.listing_id}`)
      .setLabel(`交出 ${sellable.toLocaleString()}（領 ${giveForSellable.toLocaleString()}）`)
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${SWAP_CUSTOM_PREFIX}${l.listing_id}`)
      .setLabel("自訂數量")
      .setEmoji("✏️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ABORT_ID)
      .setLabel("取消")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    container,
    row,
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  };
}

function buildSwapQtyModal(listingId, sellable) {
  const modal = new ModalBuilder()
    .setCustomId(`${SWAP_MODAL_PREFIX}${listingId}`)
    .setTitle(`賣給 #${listingId}`);
  const input = new TextInputBuilder()
    .setCustomId("bulk_qty")
    .setLabel("要交出的數量")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(9)
    .setPlaceholder(`最多可交 ${sellable}`);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

module.exports = {
  buildBrowseView,
  buildMyStallView,
  buildMyBidsView,
  buildConfirmView,
  buildBidModal,
  buildBulkFulfillView,
  buildBulkQtyModal,
  buildBulkSellBuyView,
  buildBulkSellQtyModal,
  buildSwapFulfillView,
  buildSwapQtyModal,
  buildLiveListingCard,
  oreLabel,
  itemLabel,
  listingText,
  FILTER_TYPE_ID,
  FILTER_ITEM_ID,
  // customId 前綴常數（handler 共用）
  BUY_PREFIX,
  ACCEPT_PREFIX,
  FULFILL_PREFIX,
  BID_PREFIX,
  BULK_SELL_PREFIX,
  BULK_CONFIRM_PREFIX,
  BULK_CUSTOM_PREFIX,
  BULK_MODAL_PREFIX,
  BULKSELL_BUY_PREFIX,
  BULKSELL_CONFIRM_PREFIX,
  BULKSELL_CUSTOM_PREFIX,
  BULKSELL_MODAL_PREFIX,
  SWAP_SELL_PREFIX,
  SWAP_CONFIRM_PREFIX,
  SWAP_CUSTOM_PREFIX,
  SWAP_MODAL_PREFIX,
  RENEW_PREFIX,
  CANCEL_PREFIX,
  CONFIRM_BUY,
  CONFIRM_ACCEPT,
  CONFIRM_FULFILL,
  CONFIRM_CANCEL,
  ABORT_ID,
  PAGE_PREV,
  PAGE_NEXT,
  REFRESH_ID,
  VIEW_BROWSE_ID,
  VIEW_MYSTALL_ID,
  VIEW_MYBIDS_ID,
  VIEW_BARTER_ID,
  BID_MODAL_PREFIX,
};
