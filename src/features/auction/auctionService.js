require("colors");
const crypto = require("crypto");
const { mining, auction } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");

// 結算時依賣家的 Twitch tier 決定手續費率（Tier3 享優惠費率）。
// cron 內只有 seller_id，需補抓 member；抓不到就退回設定的預設費率。
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

function cfg() {
  return auction || {};
}

function minStartPrice(oreKey) {
  const price = mining?.ores?.[oreKey]?.price || 0;
  const factor = cfg().minStartPriceFactor ?? 0.8;
  return Math.max(1, Math.ceil(price * factor));
}

function minNextBid(listing) {
  if (!listing.current_bid) return listing.start_price;
  const rate = cfg().minBidIncrementRate ?? 0.05;
  return listing.current_bid + Math.max(1, Math.ceil(listing.current_bid * rate));
}

async function genListingId(client, guildId) {
  for (let i = 0; i < 6; i++) {
    const id = crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
    const exists = await client.auctionListingsCollection
      .findOne({ guild_id: guildId, listing_id: id })
      .catch(() => null);
    if (!exists) return id;
  }
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}

// 掛牌：把礦石從賣家背包託管到拍賣品。
async function createListing(
  client,
  { sellerId, guildId, sellerName, ore, qty, startPrice }
) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.auctionListingsCollection) return { ok: false, reason: "disabled" };

  const oreDef = mining?.ores?.[ore];
  if (!oreDef) return { ok: false, reason: "no_ore" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minStart = minStartPrice(ore);
  if (!Number.isFinite(startPrice) || startPrice < minStart) {
    return { ok: false, reason: "low_start", minStart, oreDef };
  }

  const activeCount = await client.auctionListingsCollection.countDocuments({
    guild_id: guildId,
    seller_id: sellerId,
    status: "active",
  });
  const maxActive = c.maxActivePerSeller ?? 5;
  if (activeCount >= maxActive) {
    return { ok: false, reason: "too_many", maxActive };
  }

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.backpack?.[ore] || 0;
  if (have < qty) return { ok: false, reason: "insufficient", have, oreDef };

  // 託管：先扣賣家背包
  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`backpack.${ore}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const listingId = await genListingId(client, guildId);
  const now = Date.now();
  const expiresAt = new Date(now + (c.durationMs ?? 86400000));
  const listing = {
    listing_id: listingId,
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    ore,
    qty,
    start_price: startPrice,
    current_bid: null,
    bidder_id: null,
    bidder_name: null,
    status: "active",
    created_at: new Date(),
    expires_at: expiresAt,
  };
  await client.auctionListingsCollection.insertOne(listing);

  return { ok: true, listing, oreDef };
}

async function listActive(client, guildId, limit = 15) {
  if (!client.auctionListingsCollection) return [];
  return client.auctionListingsCollection
    .find({ guild_id: guildId, status: "active" })
    .sort({ expires_at: 1 })
    .limit(limit)
    .toArray();
}

// 出價：託管出價金額，退回前一位出價者。
async function placeBid(
  client,
  { listingId, bidderId, guildId, bidderName, member, amount }
) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.auctionListingsCollection || !client.userCoinsCollection) {
    return { ok: false, reason: "disabled" };
  }

  const listing = await client.auctionListingsCollection.findOne({
    guild_id: guildId,
    listing_id: listingId,
    status: "active",
  });
  if (!listing) return { ok: false, reason: "not_found" };
  if (Date.now() > new Date(listing.expires_at).getTime()) {
    return { ok: false, reason: "ended" };
  }
  if (listing.seller_id === bidderId) return { ok: false, reason: "own_listing" };

  const required = minNextBid(listing);
  if (!Number.isFinite(amount) || amount < required) {
    return { ok: false, reason: "too_low", required, listing };
  }

  const balanceDoc = await client.userCoinsCollection
    .findOne({ userId: bidderId, guildId })
    .catch(() => null);
  if ((balanceDoc?.totalCoins || 0) < amount) {
    return { ok: false, reason: "insufficient", balance: balanceDoc?.totalCoins || 0 };
  }

  // 託管出價金額
  const debit = await grantCoins(client, {
    userId: bidderId,
    guildId,
    username: bidderName,
    amount: -amount,
    source: "auction_bid",
    member,
    meta: { listingId },
  });
  if (!debit) return { ok: false, reason: "grant_failed" };

  // 樂觀鎖：current_bid / bidder 沒被別人改才更新
  const prevBid = listing.current_bid;
  const prevBidder = listing.bidder_id;
  const updated = await client.auctionListingsCollection.findOneAndUpdate(
    {
      guild_id: guildId,
      listing_id: listingId,
      status: "active",
      current_bid: prevBid,
      bidder_id: prevBidder,
    },
    {
      $set: {
        current_bid: amount,
        bidder_id: bidderId,
        bidder_name: bidderName,
        updated_at: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  const doc = updated?.value || updated;
  if (!doc) {
    // 同時間有人捷足先登 → 退回剛託管的金額
    await grantCoins(client, {
      userId: bidderId,
      guildId,
      username: bidderName,
      amount,
      source: "auction_refund",
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
      source: "auction_refund",
      meta: { listingId, reason: "outbid" },
    }).catch(() => {});
  }

  return { ok: true, listing: doc, prevBidderId: prevBidder, oreDef: mining?.ores?.[doc.ore] };
}

// 結算（cron 用）：有人得標 → 賣家收款、礦石給得標者；無人 → 退回賣家。
async function settleListing(client, listing) {
  const c = cfg();
  const locked = await client.auctionListingsCollection.findOneAndUpdate(
    { listing_id: listing.listing_id, guild_id: listing.guild_id, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return null;

  if (listing.bidder_id && listing.current_bid) {
    const feeRate = await resolveSellerFeeRate(client, listing, c.feeRate ?? 0.05);
    const fee = Math.floor(listing.current_bid * feeRate);
    const proceeds = listing.current_bid - fee;

    // 賣家收款（已扣手續費）
    await grantCoins(client, {
      userId: listing.seller_id,
      guildId: listing.guild_id,
      username: listing.seller_name,
      amount: proceeds,
      source: "auction_payout",
      meta: { listingId: listing.listing_id, fee, gross: listing.current_bid },
    }).catch(() => {});

    // 礦石撥給得標者
    await client.miningProfilesCollection
      .updateOne(
        { userId: listing.bidder_id, guildId: listing.guild_id },
        {
          $inc: { [`backpack.${listing.ore}`]: listing.qty },
          $setOnInsert: {
            userId: listing.bidder_id,
            guildId: listing.guild_id,
            createdAt: new Date(),
          },
          $set: { updatedAt: new Date() },
        },
        { upsert: true }
      )
      .catch((e) => console.log(`[ERROR] auction deliver ore: ${e}`.red));

    await client.auctionListingsCollection.updateOne(
      { listing_id: listing.listing_id, guild_id: listing.guild_id },
      { $set: { status: "sold", fee, proceeds, settled_at: new Date() } }
    );
    return { outcome: "sold", listing, fee, proceeds };
  }

  // 無人出價 → 退回賣家背包
  await client.miningProfilesCollection
    .updateOne(
      { userId: listing.seller_id, guildId: listing.guild_id },
      { $inc: { [`backpack.${listing.ore}`]: listing.qty }, $set: { updatedAt: new Date() } }
    )
    .catch((e) => console.log(`[ERROR] auction return ore: ${e}`.red));

  await client.auctionListingsCollection.updateOne(
    { listing_id: listing.listing_id, guild_id: listing.guild_id },
    { $set: { status: "expired", settled_at: new Date() } }
  );
  return { outcome: "expired", listing };
}

module.exports = {
  createListing,
  listActive,
  placeBid,
  settleListing,
  minStartPrice,
  minNextBid,
};
