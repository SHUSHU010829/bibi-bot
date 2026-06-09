require("colors");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const { consume } = require("../../utils/rateLimiter");
const marketplaceService = require("../../features/marketplace/marketplaceService");
const itemAccess = require("../../features/marketplace/itemAccess");
const guildWarehouseListingService = require("../../features/guild_club/warehouse/guildWarehouseListingService");
const {
  buildBrowseView,
  buildConfirmView,
  buildBidModal,
  oreLabel,
  itemLabel,
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
  VIEW_BROWSE_ID,
  VIEW_MYSTALL_ID,
  VIEW_MYBIDS_ID,
  VIEW_BARTER_ID,
  BID_MODAL_PREFIX,
  FILTER_TYPE_ID,
  FILTER_ITEM_ID,
} = require("../../features/marketplace/marketplaceView");
const { COIN_EMOJI } = require("../../constants/coin");

const PAGE_SIZE = 5;

// 二次確認面板是 Components V2 訊息，不能被更新成「空 components」（Discord 會拒絕，
// 導致 update 直接 throw，成交／下架因此失敗）。改為更新成一段非空的狀態文字。
function statusPanel(text) {
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

module.exports = async (client, interaction) => {
  try {
    if (!client.marketListingsCollection) return;

    const cid = interaction.customId || "";
    const isMarket =
      cid.startsWith("market_");
    if (!isMarket) return;

    // ─── 篩選器（逛攤 type / item 下拉）─────────────────────────────────────
    if (interaction.isStringSelectMenu() && (cid === FILTER_TYPE_ID || cid === FILTER_ITEM_ID)) {
      const rl = consume(interaction.user.id, "market:browse", { windowMs: 1000, max: 3 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 切換太快，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      // 讀當前訊息的兩個 select 選中值（從舊 message 拿另一個 filter 的當前值）
      // 最簡單做法：從 interaction.message 的 components 解析，或直接給 default
      // 這裡用 interaction.message.components 解析目前另一個 filter 的選中值
      let listingType = "all";
      let itemType = "all";
      try {
        const rows = interaction.message?.components || [];
        for (const row of rows) {
          for (const comp of (row.components || [])) {
            if (comp.customId === FILTER_TYPE_ID) {
              const sel = comp.options?.find((o) => o.default);
              listingType = sel?.value || "all";
            }
            if (comp.customId === FILTER_ITEM_ID) {
              const sel = comp.options?.find((o) => o.default);
              itemType = sel?.value || "all";
            }
          }
        }
      } catch { /* 解析失敗就用 all */ }

      // 把剛選的那個覆蓋
      if (cid === FILTER_TYPE_ID) listingType = interaction.values[0] || "all";
      if (cid === FILTER_ITEM_ID) itemType = interaction.values[0] || "all";

      await interaction.deferUpdate();
      const typeArg = listingType !== "all" ? listingType : null;
      const itemArg = itemType !== "all" ? itemType : null;
      const { listings, total } = await marketplaceService.listActive(client, interaction.guildId, {
        page: 0,
        pageSize: PAGE_SIZE,
        type: typeArg,
        itemType: itemArg,
      });
      const { container, rows: viewRows } = buildBrowseView(
        listings,
        total,
        0,
        PAGE_SIZE,
        { listingType, itemType },
        interaction.user.id
      );
      return interaction.editReply({
        components: [container, ...viewRows],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 翻頁（逛攤）────────────────────────────────────────────────────────
    if (interaction.isButton() && (cid.startsWith(PAGE_PREV) || cid.startsWith(PAGE_NEXT))) {
      // 限流：翻頁
      const rl = consume(interaction.user.id, "market:browse", { windowMs: 1000, max: 2 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      // 解析 customId 格式：<prefix><page>:<listingType>:<itemType>
      const rest = cid.startsWith(PAGE_PREV)
        ? cid.slice(PAGE_PREV.length)
        : cid.slice(PAGE_NEXT.length);
      const [pageStr, ltFilter, itFilter] = rest.split(":");
      const page = parseInt(pageStr, 10) || 0;
      const typeArg = ltFilter && ltFilter !== "all" ? ltFilter : null;
      const itemArg = itFilter && itFilter !== "all" ? itFilter : null;
      const listingType = ltFilter || "all";
      const itemType = itFilter || "all";

      await interaction.deferUpdate();
      const { listings, total } = await marketplaceService.listActive(client, interaction.guildId, {
        page,
        pageSize: PAGE_SIZE,
        type: typeArg,
        itemType: itemArg,
      });
      const { container, rows } = buildBrowseView(
        listings,
        total,
        page,
        PAGE_SIZE,
        { listingType, itemType },
        interaction.user.id
      );
      return interaction.editReply({
        components: [container, ...rows],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 點「購買」按鈕 → 顯示確認面板（ephemeral）──────────────────────────
    if (interaction.isButton() && cid.startsWith(BUY_PREFIX)) {
      const listingId = cid.slice(BUY_PREFIX.length);
      const listing = await client.marketListingsCollection.findOne({
        guild_id: interaction.guildId,
        listing_id: listingId,
        listing_type: { $in: ["sell", "guild_sell"] },
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此掛單已不存在或已售出。", flags: MessageFlags.Ephemeral });
      }
      if (listing.listing_type === "sell" && listing.seller_id === interaction.user.id) {
        return interaction.reply({ content: "❌ 不能購買自己的掛單。", flags: MessageFlags.Ephemeral });
      }
      const { container, row, flags } = buildConfirmView(listing, "buy");
      return interaction.reply({ components: [container, row], flags });
    }

    // ─── 點「接受換礦」→ 確認面板（ephemeral）──────────────────────────────
    if (interaction.isButton() && cid.startsWith(ACCEPT_PREFIX)) {
      const listingId = cid.slice(ACCEPT_PREFIX.length);
      const listing = await client.marketListingsCollection.findOne({
        guild_id: interaction.guildId,
        listing_id: listingId,
        listing_type: "barter",
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此掛單已不存在或已成交。", flags: MessageFlags.Ephemeral });
      }
      if (listing.seller_id === interaction.user.id) {
        return interaction.reply({ content: "❌ 不能接受自己的換礦單。", flags: MessageFlags.Ephemeral });
      }
      const { container, row, flags } = buildConfirmView(listing, "accept");
      return interaction.reply({ components: [container, row], flags });
    }

    // ─── 點「賣給他」（fulfill want）→ 確認面板（ephemeral）────────────────
    if (interaction.isButton() && cid.startsWith(FULFILL_PREFIX)) {
      const listingId = cid.slice(FULFILL_PREFIX.length);
      const listing = await client.marketListingsCollection.findOne({
        guild_id: interaction.guildId,
        listing_id: listingId,
        listing_type: "want",
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此徵求單已不存在或已成交。", flags: MessageFlags.Ephemeral });
      }
      if (listing.seller_id === interaction.user.id) {
        return interaction.reply({ content: "❌ 不能回應自己的徵求單。", flags: MessageFlags.Ephemeral });
      }
      const { container, row, flags } = buildConfirmView(listing, "fulfill");
      return interaction.reply({ components: [container, row], flags });
    }

    // ─── 點「出價」（auction bid）→ 彈出 modal ──────────────────────────────
    if (interaction.isButton() && cid.startsWith(BID_PREFIX)) {
      const listingId = cid.slice(BID_PREFIX.length);
      const listing = await client.marketListingsCollection.findOne({
        guild_id: interaction.guildId,
        listing_id: listingId,
        listing_type: "auction",
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此競標已不存在或已結標。", flags: MessageFlags.Ephemeral });
      }
      if (listing.seller_id === interaction.user.id) {
        return interaction.reply({ content: "❌ 不能對自己的競標品出價。", flags: MessageFlags.Ephemeral });
      }
      return interaction.showModal(buildBidModal(listingId, listing));
    }

    // ─── 點「下架」→ 確認面板（ephemeral）──────────────────────────────────
    if (interaction.isButton() && cid.startsWith(CANCEL_PREFIX)) {
      // customId 格式：market_cancel_<sellerId>_<listingId>
      // 舊格式（無 sellerId）也兼容：market_cancel_<listingId>
      const rest = cid.slice(CANCEL_PREFIX.length);
      const parts = rest.split("_");
      let ownerIdFromCid = null;
      let listingId = rest;
      if (parts.length >= 2) {
        ownerIdFromCid = parts[0];
        listingId = parts.slice(1).join("_");
      }
      if (ownerIdFromCid && ownerIdFromCid !== interaction.user.id) {
        return interaction.reply({
          content: "❌ 這不是你的攤位，沒辦法下架。",
          flags: MessageFlags.Ephemeral,
        });
      }
      const listing = await client.marketListingsCollection.findOne({
        guild_id: interaction.guildId,
        listing_id: listingId,
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此掛單已不存在。", flags: MessageFlags.Ephemeral });
      }
      if (listing.seller_id !== interaction.user.id) {
        return interaction.reply({ content: "❌ 你沒有權限下架此掛單。", flags: MessageFlags.Ephemeral });
      }
      const { container, row, flags } = buildConfirmView(listing, "cancel");
      return interaction.reply({ components: [container, row], flags });
    }

    // ─── 取消按鈕（中止二次確認）─────────────────────────────────────────────
    if (interaction.isButton() && cid === ABORT_ID) {
      return interaction.update({
        components: [statusPanel("✖️ 已取消操作。")],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 確認購買（confirm buy）────────────────────────────────────────────
    if (interaction.isButton() && cid.startsWith(CONFIRM_BUY)) {
      const rl = consume(interaction.user.id, "market:buy", { windowMs: 2500, max: 1 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      // 鎖面板防重複（V2 訊息不可清空 components，改更新為處理中狀態）
      await interaction.update({
        components: [statusPanel("⏳ 處理中…")],
        flags: MessageFlags.IsComponentsV2,
      });
      const listingId = cid.slice(CONFIRM_BUY.length);
      // 先看是 sell 還是 guild_sell，分派到不同 service
      const peek = await client.marketListingsCollection.findOne(
        { guild_id: interaction.guildId, listing_id: listingId },
        { projection: { listing_type: 1 } }
      );
      const isGuildSell = peek?.listing_type === "guild_sell";
      const result = isGuildSell
        ? await guildWarehouseListingService.purchase(client, {
            listingId,
            buyerId: interaction.user.id,
            guildId: interaction.guildId,
            buyerName: interaction.member?.displayName || interaction.user.username,
            member: interaction.member,
          })
        : await marketplaceService.buyNow(client, {
            listingId,
            buyerId: interaction.user.id,
            guildId: interaction.guildId,
            buyerName: interaction.member?.displayName || interaction.user.username,
            member: interaction.member,
          });
      if (result.ok && !isGuildSell) {
        const l = result.listing;
        marketplaceService.dmUser(
          client,
          l.seller_id,
          `💰 你的賣礦掛單 **#${l.listing_id}** ${itemLabel(l)} ×${l.qty} 已售出！\n` +
            `售價 **${l.price.toLocaleString()}** 🪙（手續費 ${result.fee || 0}），金幣已入帳。`
        );
      }
      return interaction.editReply({
        components: [statusPanel(isGuildSell ? formatGuildSellBuyResult(result) : formatBuyResult(result))],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 確認換礦（confirm accept）────────────────────────────────────────
    if (interaction.isButton() && cid.startsWith(CONFIRM_ACCEPT)) {
      const rl = consume(interaction.user.id, "market:buy", { windowMs: 2500, max: 1 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      await interaction.update({
        components: [statusPanel("⏳ 處理中…")],
        flags: MessageFlags.IsComponentsV2,
      });
      const listingId = cid.slice(CONFIRM_ACCEPT.length);
      const result = await marketplaceService.acceptBarter(client, {
        listingId,
        acceptorId: interaction.user.id,
        guildId: interaction.guildId,
        acceptorName: interaction.member?.displayName || interaction.user.username,
      });
      if (result.ok) {
        const l = result.listing;
        marketplaceService.dmUser(
          client,
          l.seller_id,
          `🔄 你的換礦單 **#${l.listing_id}** 已成交！\n` +
            `你付出 ${oreLabel(l.ore)} ×${l.qty}，得到 ${oreLabel(l.want_ore)} ×${l.want_qty}。`
        );
      }
      return interaction.editReply({
        components: [statusPanel(formatBarterResult(result))],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 確認賣給他（confirm fulfill）─────────────────────────────────────
    if (interaction.isButton() && cid.startsWith(CONFIRM_FULFILL)) {
      const rl = consume(interaction.user.id, "market:buy", { windowMs: 2500, max: 1 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      await interaction.update({
        components: [statusPanel("⏳ 處理中…")],
        flags: MessageFlags.IsComponentsV2,
      });
      const listingId = cid.slice(CONFIRM_FULFILL.length);
      const result = await marketplaceService.fulfillWant(client, {
        listingId,
        sellerId: interaction.user.id,
        guildId: interaction.guildId,
        sellerName: interaction.member?.displayName || interaction.user.username,
        member: interaction.member,
      });
      if (result.ok) {
        const l = result.listing;
        const wantItem = marketplaceService.resolveListingItem(l);
        const payItem = marketplaceService.resolveListingPayItem(l);
        const paidStr = payItem
          ? itemAccess.itemLabel(payItem.item_type, payItem.item_key, payItem.qty)
          : `**${(l.pay_coin || 0).toLocaleString()}** 🪙`;
        marketplaceService.dmUser(
          client,
          l.seller_id,
          `📋 你的徵求單 **#${l.listing_id}** 已被滿足！\n` +
            `你收到 ${itemAccess.itemLabel(wantItem.item_type, wantItem.item_key, l.qty)}，付出 ${paidStr}。`
        );
      }
      return interaction.editReply({
        components: [statusPanel(formatFulfillResult(result))],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 確認下架（confirm cancel）────────────────────────────────────────
    if (interaction.isButton() && cid.startsWith(CONFIRM_CANCEL)) {
      const rl = consume(interaction.user.id, "market:cancel", { windowMs: 2500, max: 1 });
      if (!rl.allowed) {
        return interaction.reply({
          content: `⏳ 別急，${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試。`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
      await interaction.update({
        components: [statusPanel("⏳ 處理中…")],
        flags: MessageFlags.IsComponentsV2,
      });
      const listingId = cid.slice(CONFIRM_CANCEL.length);
      const result = await marketplaceService.cancelListing(client, {
        listingId,
        guildId: interaction.guildId,
        userId: interaction.user.id,
      });
      if (!result.ok) {
        const msgs = {
          not_found: "❌ 找不到此掛單（可能已成交）。",
          not_owner: "❌ 你沒有權限下架此掛單。",
          race: "⚡ 操作衝突，請重試。",
        };
        return interaction.editReply({
          components: [statusPanel(msgs[result.reason] || "🔧 下架失敗，請稍後再試。")],
          flags: MessageFlags.IsComponentsV2,
        });
      }
      const cancelledBack = result.listing.listing_type === "guild_sell"
        ? "物資已退回公會倉庫"
        : "託管的礦石／金幣已退回你的帳戶";
      return interaction.editReply({
        components: [statusPanel(`✅ **#${result.listing.listing_id}** 已下架，${cancelledBack}。`)],
        flags: MessageFlags.IsComponentsV2,
      });
    }

    // ─── 競標 modal submit────────────────────────────────────────────────────
    if (interaction.isModalSubmit() && cid.startsWith(BID_MODAL_PREFIX)) {
      const listingId = cid.slice(BID_MODAL_PREFIX.length);
      const rawAmount = interaction.fields.getTextInputValue("bid_amount");
      const amount = parseInt(rawAmount.replace(/[,，\s]/g, ""), 10);
      if (!Number.isFinite(amount) || amount <= 0) {
        return interaction.reply({ content: "❌ 請輸入有效的出價金額（正整數）。", flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await marketplaceService.placeBid(client, {
        listingId,
        bidderId: interaction.user.id,
        guildId: interaction.guildId,
        bidderName: interaction.member?.displayName || interaction.user.username,
        member: interaction.member,
        amount,
      });
      const { components } = buildBidResultView(result, amount);
      return interaction.editReply({
        components,
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // ─── 快捷後續：回到 /市集 逛攤 ────────────────────────────────────────────
    if (interaction.isButton() && cid === VIEW_BROWSE_ID) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { listings, total } = await marketplaceService.listActive(client, interaction.guildId, {
        page: 0,
        pageSize: PAGE_SIZE,
      });
      const { container, rows } = buildBrowseView(
        listings,
        total,
        0,
        PAGE_SIZE,
        {},
        interaction.user.id
      );
      return interaction.editReply({
        components: [container, ...rows],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // ─── 快捷後續：回到 /市集 我的攤位 ─────────────────────────────────────────
    if (interaction.isButton() && cid === VIEW_MYSTALL_ID) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { buildMyStallView } = require("../../features/marketplace/marketplaceView");
      const listings = await marketplaceService.listByOwner(
        client,
        interaction.guildId,
        interaction.user.id
      );
      const { container, rows } = buildMyStallView(listings);
      return interaction.editReply({
        components: [container, ...rows],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // ─── 快捷後續：查看我目前領先的競標 ───────────────────────────────────────
    if (interaction.isButton() && cid === VIEW_MYBIDS_ID) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { buildMyBidsView } = require("../../features/marketplace/marketplaceView");
      const listings = await marketplaceService.listByBidder(
        client,
        interaction.guildId,
        interaction.user.id
      );
      const { container, rows } = buildMyBidsView(listings);
      return interaction.editReply({
        components: [container, ...rows],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }

    // ─── 快捷後續：去看 /交易所 列表（ephemeral） ─────────────────────────────
    if (interaction.isButton() && cid === VIEW_BARTER_ID) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const barterService = require("../../features/barter/barterService");
      const { buildBoardContainer } = require("../../features/barter/barterView");
      const c = barterService.cfg();
      const pageSize = c.pageSize ?? 5;
      const { listings, total } = await barterService.listActive(client, interaction.guildId, {
        limit: pageSize,
        skip: 0,
      });
      const container = buildBoardContainer({
        listings,
        viewerId: interaction.user.id,
        total,
        page: 1,
        pageSize,
      });
      return interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    console.log(`[ERROR] handleMarketInteraction:\n${error}\n${error.stack}`.red);
    try {
      const errMsg = { content: "🔧 操作失敗，請稍後再試。", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(errMsg);
      } else {
        await interaction.reply(errMsg);
      }
    } catch (_) { /* noop */ }
  }
};

// ─── 回應格式化 ──────────────────────────────────────────────────────────────
function formatBuyResult(result) {
  if (!result.ok) {
    const msgs = {
      not_found: "❌ 此掛單已不存在或已售出。",
      own_listing: "❌ 不能購買自己的掛單。",
      backpack_full: `🎒 你的背包已滿（${result.used}/${result.cap}），無法收下礦石！`,
      insufficient_coins: `💰 餘額不足！你目前 **${(result.balance || 0).toLocaleString()}** ${COIN_EMOJI}。`,
      grant_failed: "🔧 扣款失敗，請稍後再試。",
      race: "⚡ 剛好有人同時購買，請重試。",
    };
    return msgs[result.reason] || "🔧 購買失敗，請稍後再試。";
  }
  const l = result.listing;
  const item = marketplaceService.resolveListingItem(l);
  const deliveredLine =
    item.item_type === "fish" ? "魚已放進你的魚袋 🎣"
    : item.item_type === "veggie" ? "農產品已放進你的菜籃 🌾"
    : "礦石已放進你的背包 🎒";
  return (
    `✅ **購買成功！**\n` +
    `**#${l.listing_id}** ${itemLabel(l)} ×${l.qty}\n` +
    `花費 **${l.price.toLocaleString()}** ${COIN_EMOJI}（手續費 ${result.fee || 0}）\n` +
    `${deliveredLine}`
  );
}

function formatGuildSellBuyResult(result) {
  if (!result.ok) {
    const msgs = {
      not_found: "❌ 此公會寄售已不存在或已售出。",
      unknown_kind: "❌ 物品類別異常，請通知管理員。",
      backpack_full: `🎒 你的背包已滿（${result.used}/${result.cap}），無法收下這批物資！`,
      insufficient_coins: `💰 餘額不足！你目前 **${(result.balance || 0).toLocaleString()}** ${COIN_EMOJI}（需要 ${(result.need || 0).toLocaleString()}）。`,
      grant_failed: "🔧 扣款失敗，請稍後再試。",
      race: "⚡ 剛好有人同時購買，請重試。",
    };
    return msgs[result.reason] || "🔧 購買失敗，請稍後再試。";
  }
  const l = result.listing;
  const kind = l.item_kind;
  const where =
    kind === "fish_bag" ? "魚袋 🎣" : kind === "veggie_bag" ? "菜籃 🌾" : "背包 🎒";
  return (
    `✅ **購買成功！**\n` +
    `**#${l.listing_id}** ${itemLabel(l)} ×${l.qty}（來自 🏰 ${l.guild_club_name || "公會"}）\n` +
    `花費 **${l.price.toLocaleString()}** ${COIN_EMOJI}\n` +
    `物資已放進你的${where}`
  );
}

function formatBarterResult(result) {
  if (!result.ok) {
    const msgs = {
      not_found: "❌ 此換礦單已不存在或已成交。",
      own_listing: "❌ 不能接受自己的換礦單。",
      insufficient: `🎒 你沒有足夠的 ${result.oreDef?.name || "礦石"}（持有 ${result.have}）。`,
      acceptor_full: `🎒 你的背包已滿（${result.used}/${result.cap}），無法收下礦石！`,
      seller_full: "🎒 掛單者的背包已滿，無法接受此交換！",
      race: "⚡ 剛好有人同時接受，請重試。",
    };
    return msgs[result.reason] || "🔧 換礦失敗，請稍後再試。";
  }
  const l = result.listing;
  return (
    `✅ **換礦成功！**\n` +
    `**#${l.listing_id}**\n` +
    `你付出 ${oreLabel(l.want_ore)} ×${l.want_qty}，得到 ${oreLabel(l.ore)} ×${l.qty} 🎒`
  );
}

function formatFulfillResult(result) {
  if (!result.ok) {
    const msgs = {
      not_found: "❌ 此徵求單已不存在或已成交。",
      own_listing: "❌ 不能回應自己的徵求單。",
      insufficient: `📦 你沒有足夠的 ${result.wantDef?.name || "物品"}（持有 ${result.have}）。`,
      buyer_full: "🎒 徵求者的背包已滿，無法接受此交易！",
      seller_full: `🎒 你的背包已滿，無法收下付款！`,
      race: "⚡ 剛好有人同時成交，請重試。",
    };
    return msgs[result.reason] || "🔧 賣出失敗，請稍後再試。";
  }
  const l = result.listing;
  const wantItem = result.wantItem || marketplaceService.resolveListingItem(l);
  const payItem = result.payItem || marketplaceService.resolveListingPayItem(l);
  const receiveStr = payItem
    ? itemAccess.itemLabel(payItem.item_type, payItem.item_key, payItem.qty)
    : `**${result.proceeds.toLocaleString()}** ${COIN_EMOJI}（扣除 ${result.fee} 手續費）`;
  return (
    `✅ **賣出成功！**\n` +
    `**#${l.listing_id}**\n` +
    `你賣出 ${itemAccess.itemLabel(wantItem.item_type, wantItem.item_key, l.qty)}，收到 ${receiveStr} 🎒`
  );
}

function bidFailContainer(result, amount) {
  const container = new ContainerBuilder().setAccentColor(0xe74c3c);
  const safeAmount = Number.isFinite(amount) ? amount.toLocaleString() : "—";

  const blocks = {
    not_found: {
      title: "❌ 找不到這個競標",
      detail: "可能剛好已被別人標走或已結標。",
      hint: "用 /市集 逛攤 找其他競標。",
    },
    ended: {
      title: "⌛ 競標已結束",
      detail: "這件競標品已過期或已成交。",
      hint: "用 /市集 逛攤 看現在還在進行的競標。",
    },
    own_listing: {
      title: "❌ 不能對自己的競標出價",
      detail: "這是你自己掛的攤位。",
      hint: "想取消的話，用 /市集 我的攤位 點下架。",
    },
    too_low: {
      title: "❌ 出價太低",
      detail:
        `需要至少：**${(result.required || 0).toLocaleString()}** ${COIN_EMOJI}\n` +
        `你出價：**${safeAmount}** ${COIN_EMOJI}`,
      hint: "每次至少需加價 5%（minBidIncrementRate）。",
    },
    insufficient_coins: {
      title: "❌ 餘額不足",
      detail:
        `出價需要：**${safeAmount}** ${COIN_EMOJI}（含手續費）\n` +
        `你目前有：**${(result.balance || 0).toLocaleString()}** ${COIN_EMOJI}`,
      hint: "去 /打工 或 /挖礦 賺一點再回來。",
    },
    grant_failed: {
      title: "❌ 出價失敗",
      detail: "扣款時發生問題。",
      hint: "稍後再試一次。",
    },
    race: {
      title: "⚡ 出價被人搶先",
      detail: "剛好有人同時出價，目前最高已不是你了。",
      hint: "刷新頁面查看最新價格後再試。",
    },
  };
  const b = blocks[result.reason] || {
    title: "🔧 出價失敗",
    detail: "發生未預期的錯誤。",
    hint: "稍後再試或回報舒舒。",
  };
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`# ${b.title}`)
  );
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small)
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`${b.detail}\n-# ${b.hint}`)
  );
  return container;
}

function bidSuccessButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VIEW_MYBIDS_ID)
      .setLabel("我的競標")
      .setEmoji("🏷️")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(VIEW_BROWSE_ID)
      .setLabel("查看市集")
      .setEmoji("🏪")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buyoutSuccessButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VIEW_BROWSE_ID)
      .setLabel("再逛逛市集")
      .setEmoji("🏪")
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildBidResultView(result, amount) {
  if (!result.ok) {
    return { components: [bidFailContainer(result, amount)] };
  }

  const l = result.listing;
  const item = marketplaceService.resolveListingItem(l);
  const itemLabelText = itemAccess.itemLabel(item.item_type, item.item_key, l.qty);
  const bagPhrase =
    item.item_type === "fish" ? "魚已放進你的魚袋 🎣"
    : item.item_type === "veggie" ? "農產品已放進你的菜籃 🌾"
    : "礦石已放進你的背包 🎒";
  if (result.buyout) {
    const container = new ContainerBuilder()
      .setAccentColor(0x2ecc71)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `# 💰 直接成交！\n` +
            `你以一口價 **${l.current_bid.toLocaleString()}** ${COIN_EMOJI} 買下 ` +
            `**#${l.listing_id}** ${itemLabelText}！\n` +
            bagPhrase
        )
      )
      .addActionRowComponents(buyoutSuccessButtons());
    return { components: [container] };
  }

  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const buyoutLine = l.buyout_price
    ? `\n💰 出到 **${l.buyout_price.toLocaleString()}** ${COIN_EMOJI} 可直接成交。`
    : "";
  const container = new ContainerBuilder()
    .setAccentColor(0x2ecc71)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ✅ 出價成功\n` +
          `你對 **#${l.listing_id}** ${itemLabelText} 出價 ` +
          `**${l.current_bid.toLocaleString()}** ${COIN_EMOJI}，目前最高！\n` +
          `截止 <t:${expiresEpoch}:R>，若被超越會自動退款。${buyoutLine}`
      )
    )
    .addActionRowComponents(bidSuccessButtons());
  return { components: [container] };
}
