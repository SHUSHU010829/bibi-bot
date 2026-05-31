require("colors");
const {
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags,
} = require("discord.js");
const { consume } = require("../../utils/rateLimiter");
const marketplaceService = require("../../features/marketplace/marketplaceService");
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
      const { container, rows: viewRows } = buildBrowseView(listings, total, 0, PAGE_SIZE, { listingType, itemType });
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
      const { container, rows } = buildBrowseView(listings, total, page, PAGE_SIZE, { listingType, itemType });
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
        listing_type: "sell",
        status: "active",
      });
      if (!listing) {
        return interaction.reply({ content: "❌ 此掛單已不存在或已售出。", flags: MessageFlags.Ephemeral });
      }
      if (listing.seller_id === interaction.user.id) {
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
      const listingId = cid.slice(CANCEL_PREFIX.length);
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
      const result = await marketplaceService.buyNow(client, {
        listingId,
        buyerId: interaction.user.id,
        guildId: interaction.guildId,
        buyerName: interaction.member?.displayName || interaction.user.username,
        member: interaction.member,
      });
      if (result.ok) {
        const l = result.listing;
        marketplaceService.dmUser(
          client,
          l.seller_id,
          `💰 你的賣礦掛單 **#${l.listing_id}** ${oreLabel(l.ore)} ×${l.qty} 已售出！\n` +
            `售價 **${l.price.toLocaleString()}** 🪙（手續費 ${result.fee || 0}），金幣已入帳。`
        );
      }
      return interaction.followUp({
        content: formatBuyResult(result),
        flags: MessageFlags.Ephemeral,
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
      return interaction.followUp({
        content: formatBarterResult(result),
        flags: MessageFlags.Ephemeral,
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
        const paidStr = l.pay_kind === "coin"
          ? `**${(l.pay_coin || 0).toLocaleString()}** 🪙`
          : `${oreLabel(l.pay_ore)} ×${l.pay_qty}`;
        marketplaceService.dmUser(
          client,
          l.seller_id,
          `📋 你的徵求單 **#${l.listing_id}** 已被滿足！\n` +
            `你收到 ${oreLabel(l.ore)} ×${l.qty}，付出 ${paidStr}。`
        );
      }
      return interaction.followUp({
        content: formatFulfillResult(result),
        flags: MessageFlags.Ephemeral,
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
        return interaction.followUp({
          content: msgs[result.reason] || "🔧 下架失敗，請稍後再試。",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.followUp({
        content: `✅ **#${result.listing.listing_id}** 已下架，託管的礦石／金幣已退回你的帳戶。`,
        flags: MessageFlags.Ephemeral,
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
      return interaction.editReply({ content: formatBidResult(result, amount), flags: MessageFlags.Ephemeral });
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
  return (
    `✅ **購買成功！**\n` +
    `**#${l.listing_id}** ${oreLabel(l.ore)} ×${l.qty}\n` +
    `花費 **${l.price.toLocaleString()}** ${COIN_EMOJI}（手續費 ${result.fee || 0}）\n` +
    `礦石已放進你的背包 🎒`
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
      insufficient: `🎒 你沒有足夠的 ${result.oreDef?.name || "礦石"}（持有 ${result.have}）。`,
      buyer_full: "🎒 徵求者的背包已滿，無法接受此交易！",
      seller_full: `🎒 你的背包已滿，無法收下付款！`,
      race: "⚡ 剛好有人同時成交，請重試。",
    };
    return msgs[result.reason] || "🔧 賣礦失敗，請稍後再試。";
  }
  const l = result.listing;
  const receiveStr = l.pay_kind === "coin"
    ? `**${result.proceeds.toLocaleString()}** ${COIN_EMOJI}（扣除 ${result.fee} 手續費）`
    : `${oreLabel(l.pay_ore)} ×${l.pay_qty}`;
  return (
    `✅ **賣礦成功！**\n` +
    `**#${l.listing_id}**\n` +
    `你賣出 ${oreLabel(l.ore)} ×${l.qty}，收到 ${receiveStr} 🎒`
  );
}

function formatBidResult(result, amount) {
  if (!result.ok) {
    const msgs = {
      not_found: "❌ 找不到這個競標（可能已結標）。",
      ended: "⌛ 這件競標品已結標了。",
      own_listing: "❌ 不能對自己的競標品出價。",
      too_low: `❌ 出價太低，至少要 **${(result.required || 0).toLocaleString()}** ${COIN_EMOJI}。`,
      insufficient_coins: `💰 餘額不足！你目前 **${(result.balance || 0).toLocaleString()}** ${COIN_EMOJI}。`,
      grant_failed: "🔧 出價失敗，請稍後再試。",
      race: "⚡ 剛好有人同時出價，請查看最新價格後再試。",
    };
    return msgs[result.reason] || "🔧 出價失敗，請稍後再試。";
  }

  const l = result.listing;
  if (result.buyout) {
    return (
      `# 💰 直接成交！\n` +
      `你以一口價 **${l.current_bid.toLocaleString()}** ${COIN_EMOJI} 買下 **#${l.listing_id}** ${oreLabel(l.ore)} ×${l.qty}！\n` +
      `礦石已放進你的背包 🎒`
    );
  }

  const expiresEpoch = Math.floor(new Date(l.expires_at).getTime() / 1000);
  const buyoutLine = l.buyout_price
    ? `\n💰 出到 **${l.buyout_price.toLocaleString()}** ${COIN_EMOJI} 可直接成交。`
    : "";
  return (
    `✅ **出價成功**\n` +
    `你對 **#${l.listing_id}** ${oreLabel(l.ore)} ×${l.qty} 出價 **${l.current_bid.toLocaleString()}** ${COIN_EMOJI}，目前最高！\n` +
    `截止 <t:${expiresEpoch}:R>，若被超越會自動退款。${buyoutLine}`
  );
}
