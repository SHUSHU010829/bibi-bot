require("colors");
const crypto = require("crypto");
const { guildWarehouse, mining } = require("../../../config");
const guildClubService = require("../guildClubService");
const grantCoins = require("../../economy/grantCoins");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../../mining/miningProfile");
const {
  itemDef,
  marketValue,
} = require("./warehouseSettings");

const PROFILE = "miningProfilesCollection";

const BAG_FIELD = {
  backpack: "backpack",
  fish_bag: "fish_bag",
  veggie_bag: "veggie_bag",
};
const ITEM_TYPE = {
  backpack: "ore",
  fish_bag: "fish",
  veggie_bag: "veggie",
};

const cfg = () => guildWarehouse?.consignment || {};

const genListingId = async (client, guildId) => {
  for (let i = 0; i < 6; i++) {
    const id = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const exists = await client.marketListingsCollection
      .findOne({ guild_id: guildId, listing_id: id })
      .catch(() => null);
    if (!exists) return id;
  }
  return crypto.randomUUID().slice(0, 8).toUpperCase();
};

const minPriceFor = (itemId, qty) => {
  const def = itemDef(itemId);
  if (!def) return 1;
  const factor = cfg().minPriceFactor ?? 0.5;
  return Math.max(1, Math.ceil(def.unitPrice * qty * factor));
};

const perTakeCap = (kind) =>
  kind === "backpack"
    ? cfg().perTakeMaxBackpack ?? 200
    : cfg().perTakeMaxFishOrVeggie ?? 200;

const createListing = async (
  client,
  { userId, guildId, sellerName, itemId, qty, price }
) => {
  if (!cfg().enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const def = itemDef(itemId);
  if (!def) return { ok: false, reason: "unknown_item" };
  if (def.craftedOnly) return { ok: false, reason: "crafted_only_no_consign" };
  if (!Number.isInteger(qty) || qty <= 0)
    return { ok: false, reason: "invalid_qty" };
  if (!Number.isInteger(price) || price <= 0)
    return { ok: false, reason: "invalid_price" };

  const cap = perTakeCap(def.kind);
  if (qty > cap)
    return { ok: false, reason: "qty_over_limit", limit: cap, asked: qty };

  const minPrice = minPriceFor(itemId, qty);
  if (price < minPrice)
    return { ok: false, reason: "price_too_low", minPrice, asked: price };

  const membership = await guildClubService.getMembership(client, userId, guildId);
  if (!membership) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(membership.role))
    return { ok: false, reason: "not_manager" };

  const club = await guildClubService.getClubById(client, membership.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const activeCount = await client.marketListingsCollection.countDocuments({
    guild_id: guildId,
    guild_club_id: club.guild_club_id,
    listing_type: "guild_sell",
    status: "active",
  });
  const maxActive = cfg().maxActivePerClub ?? 5;
  if (activeCount >= maxActive)
    return { ok: false, reason: "too_many", max: maxActive, count: activeCount };

  // 原子扣 warehouse available_qty（避免兩個管理者同時上架同一物品超賣）
  const dec = await client.guildClubWarehouseCollection.findOneAndUpdate(
    {
      guild_club_id: club.guild_club_id,
      item_id: itemId,
      available_qty: { $gte: qty },
    },
    {
      $inc: { qty: -qty, available_qty: -qty },
      $set: { updated_at: new Date() },
    },
    { returnDocument: "after" }
  );
  const updRow = dec?.value || dec;
  if (!updRow) return { ok: false, reason: "warehouse_not_enough_available" };

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (cfg().durationMs || 172800000));
  const doc = {
    listing_id: listingId,
    listing_type: "guild_sell",
    seller_id: userId,
    seller_name: sellerName || "管理者",
    guild_id: guildId,
    guild_club_id: club.guild_club_id,
    guild_club_name: club.name,
    item_id: itemId,
    item_kind: def.kind,
    item_type: ITEM_TYPE[def.kind],
    qty,
    price,
    status: "active",
    escrow_warehouse: { item_id: itemId, qty },
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };

  try {
    await client.marketListingsCollection.insertOne(doc);
  } catch (e) {
    // 插入失敗 → 退回 warehouse
    await client.guildClubWarehouseCollection.updateOne(
      { _id: updRow._id },
      { $inc: { qty, available_qty: qty }, $set: { updated_at: new Date() } }
    ).catch(() => {});
    return { ok: false, reason: "listing_insert_failed" };
  }

  await client.guildClubWarehouseLogsCollection.insertOne({
    guild_club_id: club.guild_club_id,
    user_id: userId,
    action: "consign_listed",
    item_id: itemId,
    qty,
    fee: 0,
    market_value: marketValue(itemId, qty),
    listing_id: listingId,
    price,
    created_at: now,
  }).catch(() => {});

  return { ok: true, listing: doc, club, item: { ...def, _id: itemId } };
};

const purchase = async (
  client,
  { listingId, buyerId, guildId, buyerName, member }
) => {
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const listing = await client.marketListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    listing_type: "guild_sell",
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };

  const kind = listing.item_kind;
  const bagField = BAG_FIELD[kind];
  if (!bagField) return { ok: false, reason: "unknown_kind" };

  // 背包類需要檢查容量
  if (kind === "backpack") {
    const buyer = await getOrCreate(client, buyerId, guildId);
    const cap = backpackCapacity(buyer, mining);
    const used = backpackUsed(buyer);
    if (used + listing.qty > cap)
      return { ok: false, reason: "backpack_full", cap, used };
  }

  const balanceDoc = await client.userCoinsCollection
    .findOne({ userId: buyerId, guildId })
    .catch(() => null);
  if ((balanceDoc?.totalCoins || 0) < listing.price)
    return {
      ok: false,
      reason: "insufficient_coins",
      balance: balanceDoc?.totalCoins || 0,
      need: listing.price,
    };

  // 樂觀鎖 active → settling
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  const debit = await grantCoins(client, {
    userId: buyerId,
    guildId,
    username: buyerName,
    amount: -listing.price,
    source: "guild_consign_buy",
    member,
    meta: { listingId, guild_club_id: listing.guild_club_id, item_id: listing.item_id },
  });
  if (!debit) {
    await client.marketListingsCollection.updateOne(
      { guild_id: guildId, listing_id: listingId },
      { $set: { status: "active", updated_at: new Date() } }
    ).catch(() => {});
    return { ok: false, reason: "grant_failed" };
  }

  // 全額入公會金庫（無手續費）
  await client.guildsClubCollection.updateOne(
    { guild_club_id: listing.guild_club_id, disbanded_at: null },
    { $inc: { treasury_current: listing.price }, $set: { updated_at: new Date() } }
  ).catch(() => {});

  // 交貨到買家對應袋子
  await client[PROFILE].updateOne(
    { userId: buyerId, guildId },
    {
      $inc: { [`${bagField}.${listing.item_id}`]: listing.qty },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] guild_sell deliver: ${e}`.red));

  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    {
      $set: {
        status: "sold",
        proceeds: listing.price,
        fee: 0,
        buyer_id: buyerId,
        buyer_name: buyerName,
        settled_at: new Date(),
      },
    }
  ).catch(() => {});

  await client.guildClubWarehouseLogsCollection.insertOne({
    guild_club_id: listing.guild_club_id,
    user_id: buyerId,
    action: "consign_sold",
    item_id: listing.item_id,
    qty: listing.qty,
    fee: 0,
    market_value: marketValue(listing.item_id, listing.qty),
    listing_id: listingId,
    price: listing.price,
    created_at: new Date(),
  }).catch(() => {});

  return { ok: true, listing, item: { ...itemDef(listing.item_id), _id: listing.item_id } };
};

// 把 listing escrow 內的物品退回公會倉庫 available_qty（取消 / 過期共用）
const refundToWarehouse = async (client, listing) => {
  const esc = listing.escrow_warehouse;
  if (!esc || !esc.item_id || !esc.qty) return { ok: false, reason: "no_escrow" };

  await client.guildClubWarehouseCollection.updateOne(
    { guild_club_id: listing.guild_club_id, item_id: esc.item_id },
    {
      $setOnInsert: {
        guild_club_id: listing.guild_club_id,
        item_id: esc.item_id,
      },
      $inc: { qty: esc.qty, available_qty: esc.qty },
      $set: { updated_at: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] guild_sell refund: ${e}`.red));

  await client.guildClubWarehouseLogsCollection.insertOne({
    guild_club_id: listing.guild_club_id,
    user_id: listing.seller_id,
    action: "consign_returned",
    item_id: esc.item_id,
    qty: esc.qty,
    fee: 0,
    market_value: marketValue(esc.item_id, esc.qty),
    listing_id: listing.listing_id,
    price: listing.price,
    created_at: new Date(),
  }).catch(() => {});

  return { ok: true };
};

module.exports = {
  createListing,
  purchase,
  refundToWarehouse,
  minPriceFor,
  perTakeCap,
};
