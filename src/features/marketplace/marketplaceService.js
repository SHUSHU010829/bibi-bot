require("colors");
const crypto = require("crypto");
const { MessageFlags } = require("discord.js");
const { mining, marketplace, fishing, farming } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../mining/miningProfile");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");
const mailbox = require("./marketplaceMailbox");
const itemAccess = require("./itemAccess");
const marketSaleMonitor = require("../economy/marketSaleMonitor");

function cfg() {
  return marketplace || {};
}

// 清理玩家自填標題：剝掉 Discord mention / channel / @everyone / 換行，trim、限長 30。
// 空字串視為「沒設標題」回傳 null。
function sanitizeTitle(raw) {
  if (typeof raw !== "string") return null;
  let s = raw
    .replace(/<@!?\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/@everyone/gi, "")
    .replace(/@here/gi, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (s.length === 0) return null;
  if (s.length > 30) s = s.slice(0, 30);
  return s;
}

// 私訊通知使用者（對方關閉私訊時靜默失敗，不影響交易流程）
async function dmUser(client, userId, content) {
  if (!client || !userId) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send(content);
  } catch (err) {
    console.log(`[WARN] marketplace DM 失敗（${userId}）：${err?.message || err}`.yellow);
  }
}

// 記錄公開掛單卡的訊息位置，供後續即時更新（成交進度、收滿、下架、到期）
async function setListingCardRef(client, { guildId, listingId, channelId, messageId }) {
  if (!client.marketListingsCollection || !channelId || !messageId) return;
  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { card_channel_id: channelId, card_message_id: messageId } }
  ).catch((e) => console.log(`[WARN] setListingCardRef: ${e?.message || e}`.yellow));
}

// 就地更新公開掛單卡（傳入最新 listing doc）。訊息被刪/無權限就靜默略過。
async function refreshListingCard(client, listing) {
  if (!listing?.card_message_id || !listing?.card_channel_id) return;
  try {
    const channel = await client.channels.fetch(listing.card_channel_id).catch(() => null);
    if (!channel?.messages) return;
    const msg = await channel.messages.fetch(listing.card_message_id).catch(() => null);
    if (!msg) return;
    const { buildLiveListingCard } = require("./marketplaceView");
    await msg.edit({ components: [buildLiveListingCard(listing)], flags: MessageFlags.IsComponentsV2 });
  } catch (e) {
    console.log(`[WARN] refreshListingCard #${listing.listing_id}: ${e?.message || e}`.yellow);
  }
}

// 重抓最新 doc 並更新公開卡（fire-and-forget 用）
async function refreshCardById(client, guildId, listingId) {
  if (!client.marketListingsCollection) return;
  const doc = await client.marketListingsCollection.findOne({ guild_id: guildId, listing_id: listingId }).catch(() => null);
  if (doc) await refreshListingCard(client, doc);
}

// 依賣家 Twitch tier 決定手續費率
async function resolveSellerFeeRate(client, listing, defaultRate) {
  try {
    const guild =
      client.guilds.cache.get(listing.guild_id) ||
      (await client.guilds.fetch(listing.guild_id).catch(() => null));
    if (!guild) return defaultRate;
    const member = await guild.members.fetch(listing.seller_id).catch(() => null);
    const perks = twitchPerks.resolvePerks(member);
    return typeof perks?.auctionFeeRate === "number" ? perks.auctionFeeRate : defaultRate;
  } catch {
    return defaultRate;
  }
}

// 產生 6 碼 hex 大寫 listing_id，不與 MarketListings 重複
async function genListingId(client, guildId) {
  for (let i = 0; i < 6; i++) {
    const id = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const exists = await client.marketListingsCollection
      .findOne({ guild_id: guildId, listing_id: id })
      .catch(() => null);
    if (!exists) return id;
  }
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}

// 系統收購基礎單價
function oreBasePrice(oreKey) {
  return mining?.ores?.[oreKey]?.price || 0;
}

// 一口價下限（賣礦）
function minSellPrice(oreKey, qty) {
  const factor = cfg().minSellPriceFactor ?? 0.8;
  return Math.max(1, Math.ceil(oreBasePrice(oreKey) * qty * factor));
}

// 一口價下限（通用：依 item_type 取基礎價）
function minSellPriceFor(itemType, key, qty) {
  const factor = cfg().minSellPriceFactor ?? 0.8;
  return Math.max(1, Math.ceil(itemAccess.basePrice(itemType, key) * qty * factor));
}

// 收購：每件最低收購單價（預設 ≥ 系統售價）
function minBulkUnitPrice(itemType, key) {
  const factor = (cfg().bulk || {}).minUnitPriceFactor ?? 1;
  return Math.max(1, Math.ceil(itemAccess.basePrice(itemType, key) * factor));
}

// 賣單：每件最低售出單價（預設 ≥ 系統售價）
function minBulkSellUnitPrice(itemType, key) {
  const factor = (cfg().bulkSell || {}).minUnitPriceFactor ?? 1;
  return Math.max(1, Math.ceil(itemAccess.basePrice(itemType, key) * factor));
}

// 掛單時長分級：回傳選定天數的 { days, ms, fee }。查無對應則退回第一級（預設 1 天／免費）。
function resolveDurationTier(durationDays) {
  const tiers = (cfg().listingDuration || {}).tiers || [{ days: 1, fee: 0 }];
  const tier = tiers.find((t) => t.days === durationDays) || tiers[0];
  return { days: tier.days, ms: tier.days * 86400000, fee: Math.max(0, tier.fee || 0) };
}

// 競標最低出價
function minNextBid(listing) {
  const c = cfg().auction || {};
  if (!listing.current_bid) return listing.start_price;
  const rate = c.minBidIncrementRate ?? 0.05;
  return listing.current_bid + Math.max(1, Math.ceil(listing.current_bid * rate));
}

// 競標起標價下限
function minAuctionStartPrice(oreKey) {
  const factor = (cfg().auction || {}).minStartPriceFactor ?? 0.8;
  return Math.max(1, Math.ceil(oreBasePrice(oreKey) * factor));
}

function minAuctionStartPriceFor(itemType, key) {
  const factor = (cfg().auction || {}).minStartPriceFactor ?? 0.8;
  return Math.max(1, Math.ceil(itemAccess.basePrice(itemType, key) * factor));
}

// 從 listing 解析「實際在交易的物品」：item_type + item_key，相容舊資料。
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

// 把 item 送進玩家的對應袋子；ore 走 backpack（容量受限，溢出進信箱）；fish/veggie 直接 inc。
async function deliverItem(client, { userId, guildId, itemType, itemKey, qty, sourceTag, listingId, listingType, reason }) {
  if (!qty || qty <= 0) return { delivered: 0, mailed: 0 };
  if (itemType === "ore") {
    const res = await mailbox.refundOreWithOverflow(client, {
      userId, guildId,
      ore: itemKey, qty,
      source: sourceTag || "marketplace",
      listingId,
      listingType,
      reason: reason || "refund",
    }).catch((e) => { console.log(`[ERROR] deliverItem ore: ${e}`.red); return null; });
    return { delivered: res?.delivered || 0, mailed: res?.mailed || 0 };
  }
  const field = itemAccess.bagField(itemType, itemKey);
  if (!field) return { delivered: 0, mailed: 0 };
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { [field]: qty },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] deliverItem ${itemType}: ${e}`.red));
  return { delivered: qty, mailed: 0 };
}

async function debitItem(client, { userId, guildId, itemType, itemKey, qty }) {
  const field = itemAccess.bagField(itemType, itemKey);
  if (!field) return false;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [field]: -qty }, $set: { updatedAt: new Date() } }
  );
  return true;
}

// 每人 active 掛單上限：依 listing_type 分桶（買單/賣單各 10、swap/其餘各自 8）。
// 不指定 type 時退回「跨所有 type 合計」的舊語義（供退場中的舊單型沿用）。
async function checkActiveLimit(client, sellerId, guildId, listingType = null) {
  const c = cfg();
  let max;
  if (listingType === "bulk") max = c.bulk?.maxActivePerBuyer ?? 10;
  else if (listingType === "bulk_sell") max = c.bulkSell?.maxActivePerSeller ?? 10;
  else if (listingType === "swap") max = c.swap?.maxActivePerSeller ?? 8;
  else max = c.maxActivePerSeller ?? 8;

  const filter = { guild_id: guildId, seller_id: sellerId, status: "active" };
  if (listingType) filter.listing_type = listingType;
  const count = await client.marketListingsCollection.countDocuments(filter);
  return { allowed: count < max, max, count };
}

// ─── 掛牌：賣礦（一口價，收金幣）─────────────────────────────────────────────
async function createSellListing(client, { sellerId, guildId, sellerName, ore, qty, price, title }) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const oreDef = mining?.ores?.[ore];
  if (!oreDef) return { ok: false, reason: "no_ore" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minPrice = minSellPrice(ore, qty);
  if (!Number.isFinite(price) || price < minPrice) {
    return { ok: false, reason: "low_price", minPrice, oreDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.backpack?.[ore] || 0;
  if (have < qty) return { ok: false, reason: "insufficient", have, oreDef };

  // 託管：扣賣家背包
  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`backpack.${ore}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "sell",
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    ore,
    qty,
    price,
    status: "active",
    escrow_ore: { ore, qty },
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, oreDef };
}

// ─── 掛牌：換礦（以物易物）────────────────────────────────────────────────────
async function createBarterListing(client, { sellerId, guildId, sellerName, giveOre, giveQty, wantOre, wantQty, title }) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const giveOreDef = mining?.ores?.[giveOre];
  const wantOreDef = mining?.ores?.[wantOre];
  if (!giveOreDef) return { ok: false, reason: "no_give_ore" };
  if (!wantOreDef) return { ok: false, reason: "no_want_ore" };
  if (giveOre === wantOre) return { ok: false, reason: "same_ore" };
  if (!Number.isFinite(giveQty) || giveQty <= 0) return { ok: false, reason: "bad_give_qty" };
  if (!Number.isFinite(wantQty) || wantQty <= 0) return { ok: false, reason: "bad_want_qty" };

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.backpack?.[giveOre] || 0;
  if (have < giveQty) return { ok: false, reason: "insufficient", have, oreDef: giveOreDef };

  // 託管：扣掛單者給出的礦
  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`backpack.${giveOre}`]: -giveQty }, $set: { updatedAt: new Date() } }
  );

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "barter",
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    ore: giveOre,
    qty: giveQty,
    want_ore: wantOre,
    want_qty: wantQty,
    status: "active",
    escrow_ore: { ore: giveOre, qty: giveQty },
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, giveOreDef, wantOreDef };
}

// ─── 掛牌：徵求（收購單）──────────────────────────────────────────────────────
// wantItemType: "ore" | "fish" | "veggie"
// payKind: 'coin' | 'item'
// payItemType / payItemKey / payQty 在 payKind === "item" 時必填
async function createWantListing(client, {
  sellerId, guildId, sellerName,
  wantItemType, wantItemKey, wantQty,
  payKind, coinAmount, payItemType, payItemKey, payQty,
  member, title,
}) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const wantDef = itemAccess.getItemDef(wantItemType, wantItemKey);
  if (!wantDef) return { ok: false, reason: "no_want_item" };
  if (!Number.isFinite(wantQty) || wantQty <= 0) return { ok: false, reason: "bad_qty" };

  if (payKind === "coin") {
    if (!Number.isFinite(coinAmount) || coinAmount <= 0)
      return { ok: false, reason: "bad_coin_amount" };
  } else if (payKind === "item") {
    const payDef = itemAccess.getItemDef(payItemType, payItemKey);
    if (!payDef) return { ok: false, reason: "no_pay_item" };
    if (payItemType === wantItemType && payItemKey === wantItemKey) return { ok: false, reason: "same_item" };
    if (!Number.isFinite(payQty) || payQty <= 0) return { ok: false, reason: "bad_pay_qty" };
  } else {
    return { ok: false, reason: "bad_pay_kind" };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));

  let escrowCoin = null;
  let escrowFee = 0;
  let escrowPayItem = null;

  if (payKind === "coin") {
    const wantFeeRate = c.wantCoinFeeRate ?? 0.05;
    escrowFee = Math.floor(coinAmount * wantFeeRate);
    const totalEscrow = coinAmount + escrowFee;
    const balanceDoc = await client.userCoinsCollection
      .findOne({ userId: sellerId, guildId })
      .catch(() => null);
    if ((balanceDoc?.totalCoins || 0) < totalEscrow) {
      return { ok: false, reason: "insufficient_coins", balance: balanceDoc?.totalCoins || 0, need: totalEscrow };
    }
    const debit = await grantCoins(client, {
      userId: sellerId,
      guildId,
      username: sellerName,
      amount: -totalEscrow,
      source: "market_escrow",
      member,
      meta: { listingId, type: "want", fee: escrowFee, gross: coinAmount },
    });
    if (!debit) return { ok: false, reason: "grant_failed" };
    escrowCoin = coinAmount;
  } else {
    const buyer = await getOrCreate(client, sellerId, guildId);
    const have = itemAccess.getInventoryQty(buyer, payItemType, payItemKey);
    if (have < payQty) {
      return { ok: false, reason: "insufficient", have, payDef: itemAccess.getItemDef(payItemType, payItemKey) };
    }
    await debitItem(client, { userId: sellerId, guildId, itemType: payItemType, itemKey: payItemKey, qty: payQty });
    escrowPayItem = { item_type: payItemType, item_key: payItemKey, qty: payQty };
  }

  const doc = {
    listing_id: listingId,
    listing_type: "want",
    item_type: wantItemType,
    item_key: wantItemKey,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    // legacy 欄位（ore 才填）僅供 marketplaceView 舊邏輯參考
    ore: wantItemType === "ore" ? wantItemKey : null,
    qty: wantQty,
    pay_kind: payKind === "item" ? "item" : "coin",
    pay_coin: payKind === "coin" ? coinAmount : null,
    pay_item_type: payKind === "item" ? payItemType : null,
    pay_item_key: payKind === "item" ? payItemKey : null,
    pay_qty: payKind === "item" ? payQty : null,
    // legacy
    pay_ore: payKind === "item" && payItemType === "ore" ? payItemKey : null,
    status: "active",
    escrow_coin: escrowCoin,
    escrow_fee: escrowFee,
    escrow_pay_item: escrowPayItem,
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, wantDef };
}

// ─── 掛牌：競標──────────────────────────────────────────────────────────────
// itemType: "ore" | "fish" | "veggie"
async function createAuctionListing(client, { sellerId, guildId, sellerName, itemType, itemKey, qty, startPrice, buyoutPrice, title }) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const itemDef = itemAccess.getItemDef(itemType, itemKey);
  if (!itemDef) return { ok: false, reason: "no_item" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minStart = minAuctionStartPriceFor(itemType, itemKey);
  if (!Number.isFinite(startPrice) || startPrice < minStart) {
    return { ok: false, reason: "low_start", minStart, itemDef };
  }
  const hasBuyout = buyoutPrice != null;
  if (hasBuyout && (!Number.isFinite(buyoutPrice) || buyoutPrice < startPrice)) {
    return { ok: false, reason: "low_buyout", startPrice, itemDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId, "auction");
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, itemType, itemKey);
  if (have < qty) return { ok: false, reason: "insufficient", have, itemDef };

  await debitItem(client, { userId: sellerId, guildId, itemType, itemKey, qty });

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "auction",
    item_type: itemType,
    item_key: itemKey,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    // legacy 欄位（向後相容讀取）
    ore: itemType === "ore" ? itemKey : null,
    fish_key: itemType === "fish" ? itemKey : null,
    veggie_key: itemType === "veggie" ? itemKey : null,
    qty,
    start_price: startPrice,
    buyout_price: hasBuyout ? buyoutPrice : null,
    current_bid: null,
    bidder_id: null,
    bidder_name: null,
    status: "active",
    escrow_ore: itemType === "ore" ? { ore: itemKey, qty } : null,
    escrow_fish: itemType === "fish" ? { fish_key: itemKey, qty } : null,
    escrow_veggie: itemType === "veggie" ? { veggie_key: itemKey, qty } : null,
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, itemDef };
}

// ─── 掛牌：收購（買家鎖定金幣，多位賣家分批賣入）──────────────────────────
// itemType: "ore" | "fish" | "veggie"；unitPrice 為「每件收購單價」（整數）
async function createBulkListing(client, { buyerId, guildId, buyerName, itemType, itemKey, qty, unitPrice, member, title, durationDays }) {
  const c = cfg();
  const bc = c.bulk || {};
  if (!c.enabled || bc.enabled === false) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection || !client.userCoinsCollection) return { ok: false, reason: "disabled" };

  const itemDef = itemAccess.getItemDef(itemType, itemKey);
  if (!itemDef) return { ok: false, reason: "no_item" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };
  const maxQty = bc.maxQty ?? 100000;
  if (qty > maxQty) return { ok: false, reason: "qty_too_large", maxQty };

  const minUnit = minBulkUnitPrice(itemType, itemKey);
  if (!Number.isFinite(unitPrice) || unitPrice < minUnit) {
    return { ok: false, reason: "low_unit_price", minUnit, itemDef };
  }

  // 每人最多 N 筆進行中的收購（依 listing_type 分桶）
  const limit = await checkActiveLimit(client, buyerId, guildId, "bulk");
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const tier = resolveDurationTier(durationDays);
  const principal = unitPrice * qty;
  const feeRate = bc.feeRate ?? 0.05;
  const fee = Math.floor(principal * feeRate);
  const totalEscrow = principal + fee;
  const needTotal = totalEscrow + tier.fee;

  const balanceDoc = await client.userCoinsCollection.findOne({ userId: buyerId, guildId }).catch(() => null);
  if ((balanceDoc?.totalCoins || 0) < needTotal) {
    return { ok: false, reason: "insufficient_coins", balance: balanceDoc?.totalCoins || 0, need: needTotal };
  }

  const listingId = await genListingId(client, guildId);
  const debit = await grantCoins(client, {
    userId: buyerId,
    guildId,
    username: buyerName,
    amount: -totalEscrow,
    source: "bulk_escrow",
    member,
    meta: { listingId, type: "bulk", fee, principal, unitPrice, qty },
  });
  if (!debit) return { ok: false, reason: "grant_failed" };

  if (tier.fee > 0) {
    await grantCoins(client, {
      userId: buyerId, guildId, username: buyerName, member,
      amount: -tier.fee, source: "listing_fee",
      meta: { listingId, type: "bulk", days: tier.days },
    }).catch((e) => console.log(`[ERROR] bulk listing_fee: ${e}`.red));
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + tier.ms);
  const doc = {
    listing_id: listingId,
    listing_type: "bulk",
    item_type: itemType,
    item_key: itemKey,
    seller_id: buyerId,
    seller_name: buyerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    ore: itemType === "ore" ? itemKey : null,
    fish_key: itemType === "fish" ? itemKey : null,
    veggie_key: itemType === "veggie" ? itemKey : null,
    qty,
    filled_qty: 0,
    unit_price: unitPrice,
    pay_coin: principal,
    status: "active",
    escrow_coin: principal,
    escrow_fee: fee,
    duration_days: tier.days,
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, itemDef, fee, totalEscrow, listingFee: tier.fee };
}

// 收購賣出前預覽：回傳剩餘需求、賣方持有量、可賣數量
async function getBulkPreview(client, { listingId, sellerId, guildId }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };
  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "bulk", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === sellerId) return { ok: false, reason: "own_listing", listing };
  const item = resolveListingItem(listing);
  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, item.item_type, item.item_key);
  const remaining = Math.max(0, listing.qty - (listing.filled_qty || 0));
  const sellable = Math.min(have, remaining);
  return { ok: true, listing, item, have, remaining, sellable };
}

// ─── 成交：收購（賣方分批賣入，可指定數量；未指定則賣「可賣上限」）──────────
async function fulfillBulk(client, { listingId, sellerId, guildId, sellerName, member, qty: requestedQty }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "bulk", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === sellerId) return { ok: false, reason: "own_listing" };

  const item = resolveListingItem(listing);
  const unit = listing.unit_price;
  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, item.item_type, item.item_key);
  if (have <= 0) {
    return { ok: false, reason: "insufficient", have, itemDef: itemAccess.getItemDef(item.item_type, item.item_key) };
  }

  // 原子預留：以 filled_qty 為條件避免超收；剩餘不足時夾到目前剩餘再試
  let sold = 0;
  let afterDoc = null;
  for (let attempt = 0; attempt < 4 && sold === 0; attempt++) {
    const fresh = attempt === 0 ? listing : await client.marketListingsCollection.findOne({
      guild_id: guildId, listing_id: listingId, listing_type: "bulk", status: "active",
    });
    if (!fresh) return { ok: false, reason: "filled" };
    const remaining = Math.max(0, fresh.qty - (fresh.filled_qty || 0));
    if (remaining <= 0) return { ok: false, reason: "filled" };
    const want = requestedQty && requestedQty > 0 ? Math.min(requestedQty, have) : have;
    const take = Math.min(want, remaining);
    if (take <= 0) return { ok: false, reason: "insufficient", have };

    const reserved = await client.marketListingsCollection.findOneAndUpdate(
      {
        guild_id: guildId, listing_id: listingId, listing_type: "bulk", status: "active",
        filled_qty: fresh.filled_qty || 0,
      },
      { $inc: { filled_qty: take, escrow_coin: -(unit * take) }, $set: { updated_at: new Date() } },
      { returnDocument: "after" }
    );
    const doc = reserved?.value || reserved;
    if (doc) { sold = take; afterDoc = doc; }
  }
  if (sold === 0) return { ok: false, reason: "race" };

  // 扣賣方庫存（有守衛；失敗則回滾預留）
  const field = itemAccess.bagField(item.item_type, item.item_key);
  const debited = await client.miningProfilesCollection.findOneAndUpdate(
    { userId: sellerId, guildId, [field]: { $gte: sold } },
    { $inc: { [field]: -sold }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!(debited?.value || debited)) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId },
      { $inc: { filled_qty: -sold, escrow_coin: unit * sold }, $set: { updated_at: new Date() } }
    );
    return { ok: false, reason: "insufficient", have };
  }

  // 交貨給買家（掛單者）；ore 背包滿的部分進信箱
  const delivery = await deliverItem(client, {
    userId: listing.seller_id, guildId,
    itemType: item.item_type, itemKey: item.item_key, qty: sold,
    sourceTag: "bulk", listingId, listingType: "bulk", reason: "bulk_fill",
  });

  // 撥款給賣方（每件 unit_price，無小數誤差）
  const proceeds = unit * sold;
  await grantCoins(client, {
    userId: sellerId, guildId, username: sellerName,
    amount: proceeds, source: "bulk_payout", member,
    meta: { listingId, unitPrice: unit, qty: sold },
  }).catch((e) => console.log(`[ERROR] bulk payout seller: ${e}`.red));

  marketSaleMonitor.recordAndCheck(client, {
    guildId,
    itemType: item.item_type,
    itemKey: item.item_key,
    qty: sold,
    unitPrice: unit,
    totalPaid: proceeds,
    buyerId: listing.seller_id,
    sellerId,
    listingType: "bulk",
  });

  const newFilled = (afterDoc.filled_qty != null) ? afterDoc.filled_qty : (listing.filled_qty || 0) + sold;
  const remainingAfter = Math.max(0, listing.qty - newFilled);
  const completed = remainingAfter <= 0;
  if (completed) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId, status: "active" },
      { $set: { status: "sold", settled_at: new Date() } }
    );
  }

  refreshCardById(client, guildId, listingId).catch(() => {});

  return {
    ok: true, listing, item, sold, unitPrice: unit, proceeds,
    mailed: delivery.mailed || 0, newFilled, remaining: remainingAfter, completed,
    itemDef: itemAccess.getItemDef(item.item_type, item.item_key),
  };
}

// 賣單／換物訂單的 escrow 剩餘量欄位路徑（供 CAS $inc 遞減）
function escrowQtyField(itemType) {
  const t = itemAccess.normalizeType(itemType);
  if (t === "ore") return "escrow_ore.qty";
  if (t === "fish") return "escrow_fish.qty";
  if (t === "veggie") return "escrow_veggie.qty";
  return null;
}

// ─── 掛牌：賣單（賣家託管物品，多位買家分批買入）──────────────────────────
// itemType: "ore" | "fish" | "veggie"；unitPrice 為「每件售出單價」（整數）
async function createBulkSellListing(client, { sellerId, guildId, sellerName, itemType, itemKey, qty, unitPrice, member, title, durationDays }) {
  const c = cfg();
  const bsc = c.bulkSell || {};
  if (!c.enabled || bsc.enabled === false) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection || !client.userCoinsCollection) return { ok: false, reason: "disabled" };

  const t = itemAccess.normalizeType(itemType);
  const itemDef = itemAccess.getItemDef(t, itemKey);
  if (!itemDef) return { ok: false, reason: "no_item" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };
  const maxQty = bsc.maxQty ?? 100000;
  if (qty > maxQty) return { ok: false, reason: "qty_too_large", maxQty };

  const minUnit = minBulkSellUnitPrice(t, itemKey);
  if (!Number.isFinite(unitPrice) || unitPrice < minUnit) {
    return { ok: false, reason: "low_unit_price", minUnit, itemDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId, "bulk_sell");
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, t, itemKey);
  if (have < qty) return { ok: false, reason: "insufficient", have, itemDef };

  const tier = resolveDurationTier(durationDays);
  if (tier.fee > 0) {
    const balanceDoc = await client.userCoinsCollection.findOne({ userId: sellerId, guildId }).catch(() => null);
    if ((balanceDoc?.totalCoins || 0) < tier.fee) {
      return { ok: false, reason: "insufficient_fee", balance: balanceDoc?.totalCoins || 0, need: tier.fee };
    }
  }

  // 託管：扣賣家袋（帶 $gte 守衛防並發超扣）
  const field = itemAccess.bagField(t, itemKey);
  const debited = await client.miningProfilesCollection.findOneAndUpdate(
    { userId: sellerId, guildId, [field]: { $gte: qty } },
    { $inc: { [field]: -qty }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!(debited?.value || debited)) return { ok: false, reason: "insufficient", have, itemDef };

  const listingId = await genListingId(client, guildId);
  if (tier.fee > 0) {
    await grantCoins(client, {
      userId: sellerId, guildId, username: sellerName, member,
      amount: -tier.fee, source: "listing_fee",
      meta: { listingId, type: "bulk_sell", days: tier.days },
    }).catch((e) => console.log(`[ERROR] bulk_sell listing_fee: ${e}`.red));
  }

  const escrow = {};
  if (t === "ore") escrow.escrow_ore = { ore: itemKey, qty };
  else if (t === "fish") escrow.escrow_fish = { fish_key: itemKey, qty };
  else if (t === "veggie") escrow.escrow_veggie = { veggie_key: itemKey, qty };

  const now = new Date();
  const doc = {
    listing_id: listingId,
    listing_type: "bulk_sell",
    item_type: t,
    item_key: itemKey,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    ore: t === "ore" ? itemKey : null,
    fish_key: t === "fish" ? itemKey : null,
    veggie_key: t === "veggie" ? itemKey : null,
    qty,
    filled_qty: 0,
    unit_price: unitPrice,
    status: "active",
    ...escrow,
    duration_days: tier.days,
    created_at: now,
    expires_at: new Date(now.getTime() + tier.ms),
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, itemDef, listingFee: tier.fee };
}

// 賣單買入前預覽：回傳剩餘量、買家餘額、容量與可買數量
async function getBulkSellPreview(client, { listingId, buyerId, guildId }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };
  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "bulk_sell", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === buyerId) return { ok: false, reason: "own_listing", listing };

  const item = resolveListingItem(listing);
  const unit = listing.unit_price;
  const remaining = Math.max(0, listing.qty - (listing.filled_qty || 0));

  const balanceDoc = await client.userCoinsCollection.findOne({ userId: buyerId, guildId }).catch(() => null);
  const balance = balanceDoc?.totalCoins || 0;
  const affordable = unit > 0 ? Math.floor(balance / unit) : remaining;

  // ore 背包放不下的部分會進買家信箱，不擋購買，只做為提示。
  let capRoom = Infinity;
  if (item.item_type === "ore") {
    const buyer = await getOrCreate(client, buyerId, guildId);
    capRoom = Math.max(0, backpackCapacity(buyer, mining) - backpackUsed(buyer));
  }
  const buyable = Math.max(0, Math.min(remaining, affordable));
  return { ok: true, listing, item, unit, remaining, balance, affordable, capRoom, buyable };
}

// ─── 成交：賣單（買方分批買入，可指定數量；未指定則買「可買上限」）──────────
async function fulfillBulkSell(client, { listingId, buyerId, guildId, buyerName, member, qty: requestedQty }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "bulk_sell", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === buyerId) return { ok: false, reason: "own_listing" };

  const item = resolveListingItem(listing);
  const unit = listing.unit_price;
  const escrowField = escrowQtyField(item.item_type);

  const balanceDoc = await client.userCoinsCollection.findOne({ userId: buyerId, guildId }).catch(() => null);
  const balance = balanceDoc?.totalCoins || 0;
  const affordable = unit > 0 ? Math.floor(balance / unit) : Infinity;
  if (affordable <= 0) return { ok: false, reason: "insufficient_coins", balance, itemDef: itemAccess.getItemDef(item.item_type, item.item_key) };

  // 原子預留：以 filled_qty 為條件避免超賣；同步遞減 escrow 剩餘量
  let bought = 0;
  let afterDoc = null;
  for (let attempt = 0; attempt < 4 && bought === 0; attempt++) {
    const fresh = attempt === 0 ? listing : await client.marketListingsCollection.findOne({
      guild_id: guildId, listing_id: listingId, listing_type: "bulk_sell", status: "active",
    });
    if (!fresh) return { ok: false, reason: "filled" };
    const remaining = Math.max(0, fresh.qty - (fresh.filled_qty || 0));
    if (remaining <= 0) return { ok: false, reason: "filled" };
    const want = requestedQty && requestedQty > 0 ? Math.min(requestedQty, affordable) : affordable;
    const take = Math.min(want, remaining);
    if (take <= 0) return { ok: false, reason: "insufficient_coins", balance };

    const reserved = await client.marketListingsCollection.findOneAndUpdate(
      {
        guild_id: guildId, listing_id: listingId, listing_type: "bulk_sell", status: "active",
        filled_qty: fresh.filled_qty || 0,
      },
      { $inc: { filled_qty: take, [escrowField]: -take }, $set: { updated_at: new Date() } },
      { returnDocument: "after" }
    );
    const doc = reserved?.value || reserved;
    if (doc) { bought = take; afterDoc = doc; }
  }
  if (bought === 0) return { ok: false, reason: "race" };

  // 扣買家金幣；失敗則回滾預留
  const cost = unit * bought;
  const debit = await grantCoins(client, {
    userId: buyerId, guildId, username: buyerName, member,
    amount: -cost, source: "bulk_sell_buy",
    meta: { listingId, unitPrice: unit, qty: bought },
  });
  if (!debit) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId },
      { $inc: { filled_qty: -bought, [escrowField]: bought }, $set: { updated_at: new Date() } }
    );
    return { ok: false, reason: "insufficient_coins", balance };
  }

  // 交貨給買家；ore 背包滿的部分進買家信箱
  const delivery = await deliverItem(client, {
    userId: buyerId, guildId,
    itemType: item.item_type, itemKey: item.item_key, qty: bought,
    sourceTag: "bulk_sell", listingId, listingType: "bulk_sell", reason: "bulk_sell_fill",
  });

  // 撥款給賣方：扣 5% 手續費（賣方發起時不預付，成交時從收益扣）
  const feeRate = await resolveSellerFeeRate(client, listing, (cfg().bulkSell || {}).feeRate ?? 0.05);
  const fee = Math.floor(cost * feeRate);
  const proceeds = cost - fee;
  await grantCoins(client, {
    userId: listing.seller_id, guildId, username: listing.seller_name,
    amount: proceeds, source: "bulk_sell_payout",
    meta: { listingId, unitPrice: unit, qty: bought, fee },
  }).catch((e) => console.log(`[ERROR] bulk_sell payout seller: ${e}`.red));

  marketSaleMonitor.recordAndCheck(client, {
    guildId,
    itemType: item.item_type,
    itemKey: item.item_key,
    qty: bought,
    unitPrice: unit,
    totalPaid: cost,
    buyerId,
    sellerId: listing.seller_id,
    listingType: "bulk_sell",
  });

  const newFilled = (afterDoc.filled_qty != null) ? afterDoc.filled_qty : (listing.filled_qty || 0) + bought;
  const remainingAfter = Math.max(0, listing.qty - newFilled);
  const completed = remainingAfter <= 0;
  if (completed) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId, status: "active" },
      { $set: { status: "sold", settled_at: new Date() } }
    );
  }

  refreshCardById(client, guildId, listingId).catch(() => {});

  return {
    ok: true, listing, item, bought, unitPrice: unit, cost, fee, proceeds,
    mailed: delivery.mailed || 0, newFilled, remaining: remainingAfter, completed,
    itemDef: itemAccess.getItemDef(item.item_type, item.item_key),
  };
}

// 物物交換分批撥付：賣家累計交出 want 到 before+take 時，應累計領到的 give 差額（整數、無殘留）
function payGive(giveQty, wantQty, before, take) {
  if (wantQty <= 0) return 0;
  return Math.floor((giveQty * (before + take)) / wantQty) - Math.floor((giveQty * before) / wantQty);
}

// ─── 掛牌：物物交換（發起者託管付出物 give，多位玩家分批交 want 領 give）──────────
async function createSwapListing(client, { sellerId, guildId, sellerName, giveType, giveKey, giveQty, wantType, wantKey, wantQty, title, durationDays, member }) {
  const c = cfg();
  const sc = c.swap || {};
  if (!c.enabled || sc.enabled === false) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection || !client.userCoinsCollection) return { ok: false, reason: "disabled" };

  const gT = itemAccess.normalizeType(giveType);
  const wT = itemAccess.normalizeType(wantType);
  const giveDef = itemAccess.getItemDef(gT, giveKey);
  const wantDef = itemAccess.getItemDef(wT, wantKey);
  if (!giveDef) return { ok: false, reason: "no_give_item" };
  if (!wantDef) return { ok: false, reason: "no_want_item" };
  if (gT === wT && giveKey === wantKey) return { ok: false, reason: "same_item" };
  if (!Number.isFinite(giveQty) || giveQty <= 0) return { ok: false, reason: "bad_give_qty" };
  if (!Number.isFinite(wantQty) || wantQty <= 0) return { ok: false, reason: "bad_want_qty" };
  const maxQty = sc.maxQty ?? 100000;
  if (giveQty > maxQty || wantQty > maxQty) return { ok: false, reason: "qty_too_large", maxQty };
  if (itemAccess.basePrice(gT, giveKey) < 1 || itemAccess.basePrice(wT, wantKey) < 1) {
    return { ok: false, reason: "untradeable" };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId, "swap");
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, gT, giveKey);
  if (have < giveQty) return { ok: false, reason: "insufficient", have, giveDef };

  const tier = resolveDurationTier(durationDays);
  if (tier.fee > 0) {
    const balanceDoc = await client.userCoinsCollection.findOne({ userId: sellerId, guildId }).catch(() => null);
    if ((balanceDoc?.totalCoins || 0) < tier.fee) {
      return { ok: false, reason: "insufficient_fee", balance: balanceDoc?.totalCoins || 0, need: tier.fee };
    }
  }

  // 託管：扣發起者的 give（帶 $gte 守衛）
  const field = itemAccess.bagField(gT, giveKey);
  const debited = await client.miningProfilesCollection.findOneAndUpdate(
    { userId: sellerId, guildId, [field]: { $gte: giveQty } },
    { $inc: { [field]: -giveQty }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!(debited?.value || debited)) return { ok: false, reason: "insufficient", have, giveDef };

  const listingId = await genListingId(client, guildId);
  if (tier.fee > 0) {
    await grantCoins(client, {
      userId: sellerId, guildId, username: sellerName, member,
      amount: -tier.fee, source: "listing_fee", meta: { listingId, type: "swap", days: tier.days },
    }).catch((e) => console.log(`[ERROR] swap listing_fee: ${e}`.red));
  }

  const now = new Date();
  const doc = {
    listing_id: listingId,
    listing_type: "swap",
    item_type: null,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    give: { type: gT, key: giveKey, qty: giveQty },
    want: { type: wT, key: wantKey, qty: wantQty },
    qty: wantQty,
    filled_qty: 0,
    escrow_pay_item: { item_type: gT, item_key: giveKey, qty: giveQty },
    duration_days: tier.days,
    status: "active",
    created_at: now,
    expires_at: new Date(now.getTime() + tier.ms),
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, giveDef, wantDef, listingFee: tier.fee };
}

// 物物交換成交前預覽：回傳剩餘需求、賣方持有 want、可交量與可領 give
async function getSwapPreview(client, { listingId, sellerId, guildId }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };
  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "swap", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === sellerId) return { ok: false, reason: "own_listing", listing };

  const give = listing.give;
  const want = listing.want;
  const filledWant = listing.filled_qty || 0;
  const remainingWant = Math.max(0, want.qty - filledWant);
  const fulfiller = await getOrCreate(client, sellerId, guildId);
  const haveWant = itemAccess.getInventoryQty(fulfiller, want.type, want.key);
  const sellable = Math.min(haveWant, remainingWant);
  const giveForSellable = payGive(give.qty, want.qty, filledWant, sellable);
  return { ok: true, listing, give, want, haveWant, remainingWant, sellable, giveForSellable, filledWant };
}

// ─── 成交：物物交換（賣方分批交 want、按比例領 give）──────────────────────────
async function fulfillSwap(client, { listingId, sellerId, guildId, sellerName, member, qty: requestedQty }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, listing_type: "swap", status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === sellerId) return { ok: false, reason: "own_listing" };

  const give = listing.give;
  const want = listing.want;
  const fulfiller = await getOrCreate(client, sellerId, guildId);
  const haveWant = itemAccess.getInventoryQty(fulfiller, want.type, want.key);
  if (haveWant <= 0) {
    return { ok: false, reason: "insufficient", have: haveWant, itemDef: itemAccess.getItemDef(want.type, want.key) };
  }

  // 手續費（賣方付金幣）：以「本次意圖交量」的最壞值預檢餘額，避免中途扣費失敗
  const feeRate = (cfg().swap || {}).feeRate ?? 0;
  if (feeRate > 0) {
    const before0 = listing.filled_qty || 0;
    const remaining0 = Math.max(0, want.qty - before0);
    const intendTake = Math.min(requestedQty && requestedQty > 0 ? requestedQty : haveWant, haveWant, remaining0);
    const intendGive = payGive(give.qty, want.qty, before0, intendTake);
    const value = Math.max(itemAccess.basePrice(give.type, give.key) * intendGive, itemAccess.basePrice(want.type, want.key) * intendTake);
    const estFee = Math.floor(value * feeRate);
    if (estFee > 0) {
      const balanceDoc = await client.userCoinsCollection.findOne({ userId: sellerId, guildId }).catch(() => null);
      if ((balanceDoc?.totalCoins || 0) < estFee) {
        return { ok: false, reason: "insufficient_fee", balance: balanceDoc?.totalCoins || 0, need: estFee };
      }
    }
  }

  // 原子預留：以 filled_qty 為條件避免超收；同步遞減 escrow_pay_item.qty（給出物剩餘）
  let sold = 0;
  let giveOut = 0;
  let afterDoc = null;
  for (let attempt = 0; attempt < 4 && sold === 0; attempt++) {
    const fresh = attempt === 0 ? listing : await client.marketListingsCollection.findOne({
      guild_id: guildId, listing_id: listingId, listing_type: "swap", status: "active",
    });
    if (!fresh) return { ok: false, reason: "filled" };
    const before = fresh.filled_qty || 0;
    const remaining = Math.max(0, fresh.want.qty - before);
    if (remaining <= 0) return { ok: false, reason: "filled" };
    const wantTake = requestedQty && requestedQty > 0 ? Math.min(requestedQty, haveWant) : haveWant;
    const take = Math.min(wantTake, remaining);
    if (take <= 0) return { ok: false, reason: "insufficient", have: haveWant };
    const pay = payGive(give.qty, fresh.want.qty, before, take);

    const reserved = await client.marketListingsCollection.findOneAndUpdate(
      {
        guild_id: guildId, listing_id: listingId, listing_type: "swap", status: "active",
        filled_qty: before,
      },
      { $inc: { filled_qty: take, "escrow_pay_item.qty": -pay }, $set: { updated_at: new Date() } },
      { returnDocument: "after" }
    );
    const doc = reserved?.value || reserved;
    if (doc) { sold = take; giveOut = pay; afterDoc = doc; }
  }
  if (sold === 0) return { ok: false, reason: "race" };

  // 扣賣方的 want（帶守衛，失敗回滾預留）
  const wantField = itemAccess.bagField(want.type, want.key);
  const debited = await client.miningProfilesCollection.findOneAndUpdate(
    { userId: sellerId, guildId, [wantField]: { $gte: sold } },
    { $inc: { [wantField]: -sold }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!(debited?.value || debited)) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId },
      { $inc: { filled_qty: -sold, "escrow_pay_item.qty": giveOut }, $set: { updated_at: new Date() } }
    );
    return { ok: false, reason: "insufficient", have: haveWant };
  }

  // 交 want 給發起者；交 give 給賣方（ore 滿→各自信箱）
  const wantDelivery = await deliverItem(client, {
    userId: listing.seller_id, guildId,
    itemType: want.type, itemKey: want.key, qty: sold,
    sourceTag: "swap", listingId, listingType: "swap", reason: "swap_fill",
  });
  const giveDelivery = giveOut > 0 ? await deliverItem(client, {
    userId: sellerId, guildId,
    itemType: give.type, itemKey: give.key, qty: giveOut,
    sourceTag: "swap", listingId, listingType: "swap", reason: "swap_pay",
  }) : { mailed: 0 };

  // 手續費（賣方付金幣，config 預設 0）
  let fee = 0;
  if (feeRate > 0) {
    const value = Math.max(itemAccess.basePrice(give.type, give.key) * giveOut, itemAccess.basePrice(want.type, want.key) * sold);
    fee = Math.floor(value * feeRate);
    if (fee > 0) {
      await grantCoins(client, {
        userId: sellerId, guildId, username: sellerName, member,
        amount: -fee, source: "swap_fee", meta: { listingId, sold, giveOut },
      }).catch((e) => console.log(`[ERROR] swap fee: ${e}`.red));
    }
  }

  // 反洗幣：本批價值嚴重不對等時回報疑似變相轉帳（以實際成交數量判定）
  marketSaleMonitor.checkSwapTransfer(client, {
    guildId,
    creatorId: listing.seller_id,
    fulfillerId: sellerId,
    giveType: give.type, giveKey: give.key, giveQty: giveOut,
    wantType: want.type, wantKey: want.key, wantQty: sold,
  });

  const newFilled = (afterDoc.filled_qty != null) ? afterDoc.filled_qty : (listing.filled_qty || 0) + sold;
  const remainingAfter = Math.max(0, want.qty - newFilled);
  const completed = remainingAfter <= 0;
  if (completed) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId, status: "active" },
      { $set: { status: "sold", settled_at: new Date() } }
    );
  }

  refreshCardById(client, guildId, listingId).catch(() => {});

  return {
    ok: true, listing, give, want, sold, giveOut, fee,
    wantMailed: wantDelivery.mailed || 0, giveMailed: giveDelivery.mailed || 0,
    newFilled, remaining: remainingAfter, completed,
    giveDef: itemAccess.getItemDef(give.type, give.key),
    wantDef: itemAccess.getItemDef(want.type, want.key),
  };
}

// ─── 成交：一口價賣礦（買家付金幣）─────────────────────────────────────────────
async function buyNow(client, { listingId, buyerId, guildId, buyerName, member }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    listing_type: "sell",
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === buyerId) return { ok: false, reason: "own_listing" };

  // 礦石才走背包容量檢查；fish / veggie 無上限
  const item = resolveListingItem(listing);
  if (item.item_type === "ore") {
    const buyer = await getOrCreate(client, buyerId, guildId);
    const cap = backpackCapacity(buyer, mining);
    const used = backpackUsed(buyer);
    if (used + listing.qty > cap) {
      return { ok: false, reason: "backpack_full", cap, used };
    }
  }

  // 手續費由買方支付：買家總付 = price + fee，賣家實得 = full price
  const c = cfg();
  const feeRate = await resolveSellerFeeRate(client, listing, c.sellFeeRate ?? 0.05);
  const fee = Math.floor(listing.price * feeRate);
  const totalCharge = listing.price + fee;

  // 查買家餘額
  const balanceDoc = await client.userCoinsCollection.findOne({ userId: buyerId, guildId }).catch(() => null);
  if ((balanceDoc?.totalCoins || 0) < totalCharge) {
    return { ok: false, reason: "insufficient_coins", balance: balanceDoc?.totalCoins || 0, need: totalCharge };
  }

  // 樂觀鎖 active → settling
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const lockedDoc = locked?.value || locked;
  if (!lockedDoc) return { ok: false, reason: "race" };

  // 扣買家金幣（含手續費）
  const debit = await grantCoins(client, {
    userId: buyerId,
    guildId,
    username: buyerName,
    amount: -totalCharge,
    source: "market_buy",
    member,
    meta: { listingId, fee, gross: listing.price },
  });
  if (!debit) {
    // 扣款失敗，退回 active
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId },
      { $set: { status: "active", updated_at: new Date() } }
    );
    return { ok: false, reason: "grant_failed" };
  }

  const proceeds = listing.price;

  // 撥款給賣家（全額，無扣手續費）
  await grantCoins(client, {
    userId: listing.seller_id,
    guildId,
    username: listing.seller_name,
    amount: proceeds,
    source: "market_payout",
    meta: { listingId, fee, gross: listing.price, feePaidBy: "buyer" },
  }).catch((e) => console.log(`[ERROR] market buyNow payout: ${e}`.red));

  // 交貨給買家：依 item_type 直接寫入對應袋子（ore 容量已預先驗證、fish/veggie 無上限）
  {
    const item = resolveListingItem(listing);
    const field = itemAccess.bagField(item.item_type, item.item_key);
    if (field) {
      await client.miningProfilesCollection.updateOne(
        { userId: buyerId, guildId },
        {
          $inc: { [field]: listing.qty },
          $setOnInsert: { userId: buyerId, guildId, createdAt: new Date() },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      ).catch((e) => console.log(`[ERROR] market buyNow deliver: ${e}`.red));
    }
  }

  // 標記 sold
  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "sold", fee, proceeds, buyer_id: buyerId, buyer_name: buyerName, settled_at: new Date() } }
  );

  marketSaleMonitor.recordAndCheck(client, {
    guildId,
    itemType: item.item_type,
    itemKey: item.item_key,
    qty: listing.qty,
    unitPrice: listing.price / listing.qty,
    totalPaid: listing.price,
    buyerId,
    sellerId: listing.seller_id,
    listingType: "sell",
  });

  return {
    ok: true,
    listing,
    fee,
    proceeds,
    item,
    oreDef: item.item_type === "ore" ? mining?.ores?.[item.item_key] : null,
    fishDef: item.item_type === "fish" ? fishing?.fish?.[item.item_key] : null,
    veggieDef: item.item_type === "veggie" ? farming?.crops?.[item.item_key] : null,
  };
}

// ─── 成交：換礦（接受者付 want_ore 換 give_ore）──────────────────────────────
async function acceptBarter(client, { listingId, acceptorId, guildId, acceptorName }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    listing_type: "barter",
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === acceptorId) return { ok: false, reason: "own_listing" };

  // 接受者持有量
  const acceptor = await getOrCreate(client, acceptorId, guildId);
  const haveWant = acceptor.backpack?.[listing.want_ore] || 0;
  if (haveWant < listing.want_qty) {
    return { ok: false, reason: "insufficient", have: haveWant, oreDef: mining?.ores?.[listing.want_ore] };
  }

  // 背包容量：接受者收 give_ore，掛單者收 want_ore
  const acceptorCap = backpackCapacity(acceptor, mining);
  const acceptorUsed = backpackUsed(acceptor);
  if (acceptorUsed + listing.qty > acceptorCap) {
    return { ok: false, reason: "acceptor_full", cap: acceptorCap, used: acceptorUsed };
  }
  const seller = await getOrCreate(client, listing.seller_id, guildId);
  const sellerCap = backpackCapacity(seller, mining);
  const sellerUsed = backpackUsed(seller);
  if (sellerUsed + listing.want_qty > sellerCap) {
    return { ok: false, reason: "seller_full", cap: sellerCap, used: sellerUsed };
  }

  // 樂觀鎖
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  // 扣接受者 want_ore
  await client.miningProfilesCollection.updateOne(
    { userId: acceptorId, guildId },
    { $inc: { [`backpack.${listing.want_ore}`]: -listing.want_qty }, $set: { updatedAt: new Date() } }
  ).catch((e) => console.log(`[ERROR] barter debit acceptor: ${e}`.red));

  // 加掛單者 want_ore（掛單者收到想要的礦）
  await client.miningProfilesCollection.updateOne(
    { userId: listing.seller_id, guildId },
    { $inc: { [`backpack.${listing.want_ore}`]: listing.want_qty }, $set: { updatedAt: new Date() } }
  ).catch((e) => console.log(`[ERROR] barter credit seller: ${e}`.red));

  // 加接受者 give_ore（從託管交貨）
  await client.miningProfilesCollection.updateOne(
    { userId: acceptorId, guildId },
    { $inc: { [`backpack.${listing.ore}`]: listing.qty }, $set: { updatedAt: new Date() } }
  ).catch((e) => console.log(`[ERROR] barter deliver acceptor: ${e}`.red));

  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "sold", buyer_id: acceptorId, buyer_name: acceptorName, settled_at: new Date() } }
  );

  return {
    ok: true,
    listing,
    giveOreDef: mining?.ores?.[listing.ore],
    wantOreDef: mining?.ores?.[listing.want_ore],
  };
}

// ─── 成交：徵求（賣方提供 want item，得到金幣或物品）──────────────────────────
async function fulfillWant(client, { listingId, sellerId, guildId, sellerName, member }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    listing_type: "want",
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id === sellerId) return { ok: false, reason: "own_listing" };

  const wantItem = resolveListingItem(listing);
  const payItem = resolveListingPayItem(listing); // null 表 pay_kind=coin

  // 賣方持有量（提供 want item）
  const seller = await getOrCreate(client, sellerId, guildId);
  const have = itemAccess.getInventoryQty(seller, wantItem.item_type, wantItem.item_key);
  if (have < listing.qty) {
    return { ok: false, reason: "insufficient", have, wantDef: itemAccess.getItemDef(wantItem.item_type, wantItem.item_key) };
  }

  // 買方（掛單者）背包容量（只有 ore 需要檢查）
  const buyer = await getOrCreate(client, listing.seller_id, guildId);
  if (wantItem.item_type === "ore") {
    const buyerCap = backpackCapacity(buyer, mining);
    const buyerUsed = backpackUsed(buyer);
    if (buyerUsed + listing.qty > buyerCap) {
      return { ok: false, reason: "buyer_full", cap: buyerCap, used: buyerUsed };
    }
  }

  // 若付物品且付礦，賣方收付礦時需要背包空間
  if (payItem && payItem.item_type === "ore") {
    const sellerCap = backpackCapacity(seller, mining);
    const sellerUsed = backpackUsed(seller);
    if (sellerUsed + payItem.qty > sellerCap) {
      return { ok: false, reason: "seller_full", cap: sellerCap, used: sellerUsed };
    }
  }

  // 樂觀鎖
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  // 扣賣方提供的 want item
  await debitItem(client, {
    userId: sellerId, guildId,
    itemType: wantItem.item_type, itemKey: wantItem.item_key,
    qty: listing.qty,
  }).catch((e) => console.log(`[ERROR] want debit seller: ${e}`.red));

  // 給買方（掛單者）want item
  const buyerField = itemAccess.bagField(wantItem.item_type, wantItem.item_key);
  await client.miningProfilesCollection.updateOne(
    { userId: listing.seller_id, guildId },
    {
      $inc: { [buyerField]: listing.qty },
      $setOnInsert: { userId: listing.seller_id, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] want deliver buyer: ${e}`.red));

  let fee = 0;
  let proceeds = 0;

  if (!payItem) {
    fee = listing.escrow_fee || 0;
    proceeds = listing.pay_coin;
    await grantCoins(client, {
      userId: sellerId,
      guildId,
      username: sellerName,
      amount: proceeds,
      source: "market_payout",
      member,
      meta: { listingId, fee, gross: listing.pay_coin, feePaidBy: "buyer" },
    }).catch((e) => console.log(`[ERROR] want payout seller: ${e}`.red));
  } else {
    // 付物品：從託管交給賣方（ore 容量已預先驗證，可直接 inc）
    const payField = itemAccess.bagField(payItem.item_type, payItem.item_key);
    await client.miningProfilesCollection.updateOne(
      { userId: sellerId, guildId },
      { $inc: { [payField]: payItem.qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] want deliver pay item: ${e}`.red));
  }

  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "sold", buyer_id: sellerId, buyer_name: sellerName, fee, proceeds, settled_at: new Date() } }
  );

  return {
    ok: true,
    listing,
    fee,
    proceeds,
    wantItem,
    payItem,
    wantDef: itemAccess.getItemDef(wantItem.item_type, wantItem.item_key),
  };
}

// ─── 競標出價 ────────────────────────────────────────────────────────────────
async function placeBid(client, { listingId, bidderId, guildId, bidderName, member, amount }) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection || !client.userCoinsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    listing_type: "auction",
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (Date.now() > new Date(listing.expires_at).getTime()) return { ok: false, reason: "ended" };
  if (listing.seller_id === bidderId) return { ok: false, reason: "own_listing" };

  const buyoutPrice = listing.buyout_price || null;
  const isBuyout = buyoutPrice != null && Number.isFinite(amount) && amount >= buyoutPrice;
  const charge = isBuyout ? buyoutPrice : amount;

  const required = minNextBid(listing);
  if (!isBuyout && (!Number.isFinite(amount) || amount < required)) {
    return { ok: false, reason: "too_low", required, listing };
  }

  const balanceDoc = await client.userCoinsCollection.findOne({ userId: bidderId, guildId }).catch(() => null);
  if ((balanceDoc?.totalCoins || 0) < charge) {
    return { ok: false, reason: "insufficient_coins", balance: balanceDoc?.totalCoins || 0 };
  }

  // 託管出價金幣
  const debit = await grantCoins(client, {
    userId: bidderId,
    guildId,
    username: bidderName,
    amount: -charge,
    source: "market_bid",
    member,
    meta: { listingId, buyout: isBuyout },
  });
  if (!debit) return { ok: false, reason: "grant_failed" };

  const prevBid = listing.current_bid;
  const prevBidder = listing.bidder_id;

  const updated = await client.marketListingsCollection.findOneAndUpdate(
    {
      guild_id: guildId,
      listing_id: listingId,
      listing_type: "auction",
      status: "active",
      current_bid: prevBid,
      bidder_id: prevBidder,
    },
    {
      $set: {
        current_bid: charge,
        bidder_id: bidderId,
        bidder_name: bidderName,
        status: isBuyout ? "settling" : "active",
        updated_at: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  const doc = updated?.value || updated;
  if (!doc) {
    // race — 退款
    await grantCoins(client, {
      userId: bidderId,
      guildId,
      username: bidderName,
      amount: charge,
      source: "market_refund",
      member,
      meta: { listingId, reason: "race" },
    }).catch(() => {});
    return { ok: false, reason: "race" };
  }

  // 退回前一位出價者
  if (prevBidder && prevBid) {
    await grantCoins(client, {
      userId: prevBidder,
      guildId,
      username: listing.bidder_name,
      amount: prevBid,
      source: "market_refund",
      meta: { listingId, reason: "outbid" },
    }).catch(() => {});
  }

  if (isBuyout) {
    const sale = await finalizeAuction(client, doc);
    const it = resolveListingItem(doc);
    return {
      ok: true,
      buyout: true,
      listing: sale?.listing || doc,
      prevBidderId: prevBidder,
      fee: sale?.fee,
      proceeds: sale?.proceeds,
      itemDef: itemAccess.getItemDef(it.item_type, it.item_key),
    };
  }

  // 通知賣家：有新出價（被超越的舊出價者已透過退款流程感知，不重複 DM）
  const item = resolveListingItem(doc);
  const itemText = itemAccess.itemLabel(item.item_type, item.item_key, doc.qty);
  const expiresEpoch = Math.floor(new Date(doc.expires_at).getTime() / 1000);
  dmUser(
    client,
    doc.seller_id,
    `🏷️ 你的競標 **#${doc.listing_id}**（${itemText}）有新出價！\n` +
      `目前最高：**${doc.current_bid.toLocaleString()}** 🪙（${bidderName}）\n` +
      `截止 <t:${expiresEpoch}:R>`
  );

  return { ok: true, listing: doc, prevBidderId: prevBidder, itemDef: itemAccess.getItemDef(item.item_type, item.item_key) };
}

// ─── 競標結算（cron + 一口價共用）────────────────────────────────────────────
async function finalizeAuction(client, listing) {
  const c = cfg();
  const feeRate = await resolveSellerFeeRate(client, listing, (c.auction || {}).feeRate ?? 0.05);
  const fee = Math.floor(listing.current_bid * feeRate);
  const proceeds = listing.current_bid - fee;

  await grantCoins(client, {
    userId: listing.seller_id,
    guildId: listing.guild_id,
    username: listing.seller_name,
    amount: proceeds,
    source: "market_payout",
    meta: { listingId: listing.listing_id, fee, gross: listing.current_bid },
  }).catch(() => {});

  // 交貨：依 item_type 走對應袋子（ore 滿了會進信箱）
  const item = resolveListingItem(listing);
  await deliverItem(client, {
    userId: listing.bidder_id,
    guildId: listing.guild_id,
    itemType: item.item_type,
    itemKey: item.item_key,
    qty: listing.qty,
    sourceTag: "market_auction",
    listingId: listing.listing_id,
    listingType: "auction",
    reason: "auction_won",
  });

  await client.marketListingsCollection.updateOne(
    { listing_id: listing.listing_id, guild_id: listing.guild_id },
    { $set: { status: "sold", fee, proceeds, settled_at: new Date() } }
  );

  marketSaleMonitor.recordAndCheck(client, {
    guildId: listing.guild_id,
    itemType: item.item_type,
    itemKey: item.item_key,
    qty: listing.qty,
    unitPrice: listing.current_bid / listing.qty,
    totalPaid: listing.current_bid,
    buyerId: listing.bidder_id,
    sellerId: listing.seller_id,
    listingType: "auction",
  });

  // 通知賣家：競標已成交
  const itemText = itemAccess.itemLabel(item.item_type, item.item_key, listing.qty);
  await dmUser(
    client,
    listing.seller_id,
    `🏷️ 你的競標 **#${listing.listing_id}**（${itemText}）已成交！\n` +
      `得標金額 **${listing.current_bid.toLocaleString()}** 🪙` +
      `（手續費 ${fee.toLocaleString()}，實得 **${proceeds.toLocaleString()}** 🪙）\n` +
      `金幣已存入你的帳戶。`
  );

  return { outcome: "sold", listing, fee, proceeds };
}

// ─── 取消 / 下架掛單────────────────────────────────────────────────────────
async function cancelListing(client, { listingId, guildId, userId }) {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id !== userId) return { ok: false, reason: "not_owner" };

  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const lockedDoc = locked?.value || locked;
  if (!lockedDoc) return { ok: false, reason: "race" };

  // 用剛鎖定的最新 doc 退款（收購的 escrow_coin 會隨成交遞減）
  await _refundEscrow(client, lockedDoc);

  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "cancelled", settled_at: new Date() } }
  );
  refreshCardById(client, guildId, listingId).catch(() => {});
  return { ok: true, listing: lockedDoc };
}

// ─── cron 到期結算────────────────────────────────────────────────────────────
async function settleListing(client, listing) {
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { listing_id: listing.listing_id, guild_id: listing.guild_id, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  const lockedDoc = locked?.value || locked;
  if (!lockedDoc) return null;

  if (listing.listing_type === "auction" && listing.bidder_id && listing.current_bid) {
    return finalizeAuction(client, listing);
  }

  // 其他 type 或 auction 無人出價 → 退託管（用最新 doc，收購退剩餘 escrow）
  await _refundEscrow(client, lockedDoc);
  await client.marketListingsCollection.updateOne(
    { listing_id: listing.listing_id, guild_id: listing.guild_id },
    { $set: { status: "expired", settled_at: new Date() } }
  );
  refreshCardById(client, listing.guild_id, listing.listing_id).catch(() => {});
  return { outcome: "expired", listing };
}

// 退託管（取消或到期共用）
async function _refundEscrow(client, listing) {
  const guildId = listing.guild_id;
  const sellerId = listing.seller_id;
  let mailedSummary = [];

  // 退礦（sell / barter / auction）— 背包放不下的進信箱
  if (listing.escrow_ore) {
    const res = await mailbox.refundOreWithOverflow(client, {
      userId: sellerId, guildId,
      ore: listing.escrow_ore.ore, qty: listing.escrow_ore.qty,
      source: "marketplace",
      listingId: listing.listing_id,
      listingType: listing.listing_type,
      reason: listing.status === "settling" ? "expired_or_cancelled" : "refund",
    }).catch((e) => { console.log(`[ERROR] market refund ore: ${e}`.red); return null; });
    if (res?.mailed) mailedSummary.push({ ore: listing.escrow_ore.ore, qty: res.mailed });
  }

  // 退魚（fish sell）— 魚袋無容量上限，直接寫回
  if (listing.escrow_fish) {
    await client.miningProfilesCollection.updateOne(
      { userId: sellerId, guildId },
      { $inc: { [`fish_bag.${listing.escrow_fish.fish_key}`]: listing.escrow_fish.qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] market refund fish: ${e}`.red));
  }

  // 退農產品（veggie sell）— 菜籃無容量上限，直接寫回
  if (listing.escrow_veggie) {
    await client.miningProfilesCollection.updateOne(
      { userId: sellerId, guildId },
      { $inc: { [`veggie_bag.${listing.escrow_veggie.veggie_key}`]: listing.escrow_veggie.qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] market refund veggie: ${e}`.red));
  }

  // 退付款物（want 付物品）— 走通用 deliverItem，ore 容量滿會進信箱
  if (listing.escrow_pay_item) {
    const it = listing.escrow_pay_item;
    const res = await deliverItem(client, {
      userId: sellerId, guildId,
      itemType: it.item_type, itemKey: it.item_key, qty: it.qty,
      sourceTag: "marketplace",
      listingId: listing.listing_id,
      listingType: listing.listing_type,
      reason: listing.status === "settling" ? "expired_or_cancelled" : "refund",
    });
    if (res.mailed > 0) mailedSummary.push({ ore: it.item_key, qty: res.mailed });
  }

  // 退金幣（want 付金幣）— 含建單時預付的手續費
  if (listing.escrow_coin) {
    const refundAmount = listing.escrow_coin + (listing.escrow_fee || 0);
    await grantCoins(client, {
      userId: sellerId,
      guildId,
      username: listing.seller_name,
      amount: refundAmount,
      source: "market_refund",
      meta: { listingId: listing.listing_id, reason: "cancelled_or_expired", fee: listing.escrow_fee || 0 },
    }).catch((e) => console.log(`[ERROR] market refund coin: ${e}`.red));
  }

  // 退公會寄售託管 → 退回公會倉庫 available_qty
  if (listing.escrow_warehouse) {
    const guildWarehouseListingService = require("../guild_club/warehouse/guildWarehouseListingService");
    await guildWarehouseListingService.refundToWarehouse(client, listing).catch(
      (e) => console.log(`[ERROR] market refund guild_sell: ${e}`.red)
    );
  }

  // 退付的礦（want 付礦）— 背包放不下的進信箱
  if (listing.escrow_pay_ore) {
    const res = await mailbox.refundOreWithOverflow(client, {
      userId: sellerId, guildId,
      ore: listing.escrow_pay_ore.ore, qty: listing.escrow_pay_ore.qty,
      source: "marketplace",
      listingId: listing.listing_id,
      listingType: listing.listing_type,
      reason: listing.status === "settling" ? "expired_or_cancelled" : "refund",
    }).catch((e) => { console.log(`[ERROR] market refund pay_ore: ${e}`.red); return null; });
    if (res?.mailed) mailedSummary.push({ ore: listing.escrow_pay_ore.ore, qty: res.mailed });
  }

  if (mailedSummary.length > 0) {
    const lines = mailedSummary
      .map((s) => `・${mining?.ores?.[s.ore]?.name || s.ore} ×${s.qty}`)
      .join("\n");
    dmUser(
      client,
      sellerId,
      `📬 你在市集的掛單 **#${listing.listing_id}** 退款時背包放不下，以下物品已暫存到信箱：\n${lines}\n` +
        `請用 \`/信箱\` 領取（騰出背包空間後再領）。`
    ).catch(() => {});
  }
}

// ─── 掛牌：賣魚（一口價，收金幣）─────────────────────────────────────────────
async function createFishSellListing(client, { sellerId, guildId, sellerName, fishKey, qty, price, title }) {
  const { fishing } = require("../../config");
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const fishDef = fishing?.fish?.[fishKey];
  if (!fishDef) return { ok: false, reason: "no_fish" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minPrice = Math.max(1, Math.ceil(fishDef.price * qty * (c.minSellPriceFactor ?? 0.8)));
  if (!Number.isFinite(price) || price < minPrice) {
    return { ok: false, reason: "low_price", minPrice, fishDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.fish_bag?.[fishKey] || 0;
  if (have < qty) return { ok: false, reason: "insufficient", have, fishDef };

  // 託管：扣賣家魚袋
  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`fish_bag.${fishKey}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "sell",
    item_type: "fish",
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    fish_key: fishKey,
    qty,
    price,
    status: "active",
    escrow_fish: { fish_key: fishKey, qty },
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, fishDef };
}

// ─── 掛牌：賣農產品（一口價，收金幣）─────────────────────────────────────────
async function createVeggieSellListing(client, { sellerId, guildId, sellerName, veggieKey, qty, price, title }) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const veggieDef = farming?.crops?.[veggieKey];
  if (!veggieDef) return { ok: false, reason: "no_veggie" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minPrice = minSellPriceFor("veggie", veggieKey, qty);
  if (!Number.isFinite(price) || price < minPrice) {
    return { ok: false, reason: "low_price", minPrice, veggieDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.veggie_bag?.[veggieKey] || 0;
  if (have < qty) return { ok: false, reason: "insufficient", have, veggieDef };

  await debitItem(client, { userId: sellerId, guildId, itemType: "veggie", itemKey: veggieKey, qty });

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "sell",
    item_type: "veggie",
    item_key: veggieKey,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    title: sanitizeTitle(title),
    veggie_key: veggieKey,
    qty,
    price,
    status: "active",
    escrow_veggie: { veggie_key: veggieKey, qty },
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, veggieDef };
}

// ─── 查詢────────────────────────────────────────────────────────────────────
async function listActive(client, guildId, { page = 0, pageSize = 5, type = null, itemType = null } = {}) {
  if (!client.marketListingsCollection) return { listings: [], total: 0 };
  const filter = { guild_id: guildId, status: "active" };
  if (type) filter.listing_type = type;
  if (itemType === "fish") {
    filter.item_type = "fish";
  } else if (itemType === "ore") {
    filter.$or = [{ item_type: "ore" }, { item_type: { $exists: false } }];
  } else if (itemType === "veggie") {
    filter.item_type = "veggie";
  }
  const total = await client.marketListingsCollection.countDocuments(filter);
  const listings = await client.marketListingsCollection
    .find(filter)
    .sort({ created_at: 1 })
    .skip(page * pageSize)
    .limit(pageSize)
    .toArray();
  return { listings, total };
}

async function listByOwner(client, guildId, sellerId) {
  if (!client.marketListingsCollection) return [];
  return client.marketListingsCollection
    .find({ guild_id: guildId, seller_id: sellerId, status: "active" })
    .sort({ created_at: 1 })
    .toArray();
}

// 我目前是最高出價者的所有 active 競標
async function listByBidder(client, guildId, bidderId) {
  if (!client.marketListingsCollection) return [];
  return client.marketListingsCollection
    .find({
      guild_id: guildId,
      listing_type: "auction",
      status: "active",
      bidder_id: bidderId,
    })
    .sort({ expires_at: 1 })
    .toArray();
}

// ─── 續租：延長掛單有效期並收取續租費 ────────────────────────────────────────
async function renewListing(client, { listingId, guildId, userId, username, days, member }) {
  const c = cfg();
  if (!client.marketListingsCollection || !client.userCoinsCollection) return { ok: false, reason: "disabled" };
  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId, listing_id: listingId, status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id !== userId) return { ok: false, reason: "not_owner" };

  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return { ok: false, reason: "bad_days" };
  const feePerDay = (c.listingDuration || {}).renewFeePerDay ?? 100;
  const fee = Math.max(0, Math.floor(d * feePerDay));

  if (fee > 0) {
    const balanceDoc = await client.userCoinsCollection.findOne({ userId, guildId }).catch(() => null);
    if ((balanceDoc?.totalCoins || 0) < fee) {
      return { ok: false, reason: "insufficient_fee", balance: balanceDoc?.totalCoins || 0, need: fee };
    }
    const debit = await grantCoins(client, {
      userId, guildId, username, member,
      amount: -fee, source: "renew_fee", meta: { listingId, days: d },
    });
    if (!debit) return { ok: false, reason: "grant_failed" };
  }

  const now = new Date();
  const newExpires = new Date(now.getTime() + d * 86400000);
  const updated = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { expires_at: newExpires, renew_offered: false, updated_at: now } },
    { returnDocument: "after" }
  );
  const doc = updated?.value || updated;
  if (!doc) return { ok: false, reason: "race" };
  return { ok: true, listing: doc, fee, days: d, expiresAt: newExpires };
}

module.exports = {
  createSellListing,
  createFishSellListing,
  createVeggieSellListing,
  createBarterListing,
  createWantListing,
  createAuctionListing,
  createBulkListing,
  createBulkSellListing,
  createSwapListing,
  getBulkPreview,
  getBulkSellPreview,
  getSwapPreview,
  minSellPriceFor,
  minBulkSellUnitPrice,
  resolveDurationTier,
  buyNow,
  acceptBarter,
  fulfillWant,
  fulfillBulk,
  fulfillBulkSell,
  fulfillSwap,
  placeBid,
  minBulkUnitPrice,
  cancelListing,
  settleListing,
  renewListing,
  setListingCardRef,
  refreshListingCard,
  refreshCardById,
  listActive,
  listByOwner,
  listByBidder,
  minNextBid,
  dmUser,
  minAuctionStartPrice,
  minAuctionStartPriceFor,
  resolveListingItem,
  resolveListingPayItem,
};
