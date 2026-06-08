const { barter } = require("../../config");
const { getItemDef } = require("./itemCatalog");
const inventory = require("./inventoryAdapter");
const { getOrCreate } = require("../mining/miningProfile");
const grantCoins = require("../economy/grantCoins");
const mailbox = require("../marketplace/marketplaceMailbox");

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

// 把託管物品退回賣家：礦石走信箱溢出，其他類型沒有容量上限直接寫回。
async function _refundOffer(client, listing, reason) {
  const { type, key, qty } = listing.offer;
  if (type === "ore") {
    const res = await mailbox.refundOreWithOverflow(client, {
      userId: listing.seller_id,
      guildId: listing.guild_id,
      ore: key,
      qty,
      source: "barter",
      listingId: listing.listing_id,
      listingType: "barter",
      reason,
    }).catch((e) => { console.log(`[ERROR] barter refund ore: ${e}`.red); return null; });
    if (res?.mailed && client.users) {
      const oreDef = getItemDef("ore", key);
      client.users.fetch(listing.seller_id)
        .then((u) => u.send(
          `📬 你在交易所的掛單 **#${listing.listing_id}** ${reason === "cancelled" ? "下架" : "到期"}退款時背包放不下，` +
          `已將 ${oreDef?.name || key} ×${res.mailed} 暫存到信箱。\n請用 \`/信箱\` 領取（騰出背包空間後再領）。`
        ))
        .catch(() => {});
    }
    return;
  }
  await inventory.add(client, listing.seller_id, listing.guild_id, type, key, qty).catch(() => {});
}

function cfg() {
  return barter || {};
}

function totalValue(offerDef, offerQty, wantDef, wantQty) {
  return (offerDef.price || 0) * offerQty + (wantDef.price || 0) * wantQty;
}

function computeFee(offerDef, offerQty, wantDef, wantQty) {
  const value = totalValue(offerDef, offerQty, wantDef, wantQty);
  return Math.max(0, Math.floor(value * (cfg().feeRate ?? 0.01)));
}

async function genListingId(client, guildId) {
  const last = await client.barterListingsCollection
    .find({ guild_id: guildId })
    .sort({ listing_id: -1 })
    .limit(1)
    .toArray()
    .catch(() => []);
  return (last[0]?.listing_id || 0) + 1;
}

async function createListing(client, {
  sellerId, sellerName, guildId,
  offerType, offerKey, offerQty,
  wantType, wantKey, wantQty,
  title,
}) {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: "disabled" };
  if (!client.barterListingsCollection) return { ok: false, reason: "disabled" };

  const offerDef = getItemDef(offerType, offerKey);
  const wantDef = getItemDef(wantType, wantKey);
  if (!offerDef) return { ok: false, reason: "no_offer_item" };
  if (!wantDef) return { ok: false, reason: "no_want_item" };
  if (offerType === wantType && offerKey === wantKey) {
    return { ok: false, reason: "same_item" };
  }
  if (!Number.isFinite(offerQty) || offerQty <= 0) return { ok: false, reason: "bad_offer_qty" };
  if (!Number.isFinite(wantQty) || wantQty <= 0) return { ok: false, reason: "bad_want_qty" };

  const minPrice = c.minItemPrice ?? 1;
  if ((offerDef.price || 0) < minPrice || (wantDef.price || 0) < minPrice) {
    return { ok: false, reason: "untradeable" };
  }

  const activeCount = await client.barterListingsCollection.countDocuments({
    guild_id: guildId,
    seller_id: sellerId,
    status: "active",
  });
  const max = c.maxActivePerUser ?? 3;
  if (activeCount >= max) return { ok: false, reason: "too_many", max };

  const profile = await getOrCreate(client, sellerId, guildId);
  const have = inventory.readQty(profile, offerType, offerKey);
  if (have < offerQty) {
    return { ok: false, reason: "insufficient", have, offerDef };
  }

  // 託管：扣賣方的物品
  await inventory.deduct(client, sellerId, guildId, offerType, offerKey, offerQty);

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.expiresMs ?? 604800000));
  const fee = computeFee(offerDef, offerQty, wantDef, wantQty);

  const doc = {
    listing_id: listingId,
    guild_id: guildId,
    seller_id: sellerId,
    seller_name: sellerName,
    title: sanitizeTitle(title),
    offer: { type: offerType, key: offerKey, qty: offerQty },
    want: { type: wantType, key: wantKey, qty: wantQty },
    fee_at_creation: fee,
    status: "active",
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.barterListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, offerDef, wantDef, fee };
}

async function listActive(client, guildId, { limit, skip = 0 } = {}) {
  if (!client.barterListingsCollection) return { listings: [], total: 0 };
  const c = cfg();
  const pageSize = limit ?? c.pageSize ?? 5;
  const filter = { guild_id: guildId, status: "active", expires_at: { $gt: new Date() } };
  const [listings, total] = await Promise.all([
    client.barterListingsCollection.find(filter).sort({ created_at: -1 }).skip(skip).limit(pageSize).toArray(),
    client.barterListingsCollection.countDocuments(filter),
  ]);
  return { listings, total };
}

async function listByOwner(client, guildId, userId) {
  if (!client.barterListingsCollection) return [];
  return client.barterListingsCollection
    .find({ guild_id: guildId, seller_id: userId, status: "active" })
    .sort({ created_at: -1 })
    .toArray();
}

async function getListing(client, guildId, listingId) {
  if (!client.barterListingsCollection) return null;
  return client.barterListingsCollection.findOne({ guild_id: guildId, listing_id: listingId });
}

async function cancelListing(client, { listingId, guildId, userId }) {
  if (!client.barterListingsCollection) return { ok: false, reason: "disabled" };
  const listing = await getListing(client, guildId, listingId);
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.seller_id !== userId) return { ok: false, reason: "not_owner" };
  if (listing.status !== "active") return { ok: false, reason: "not_active" };

  const locked = await client.barterListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "cancelled", settled_at: new Date(), updated_at: new Date() } },
    { returnDocument: "after" },
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  await _refundOffer(client, listing, "cancelled");
  return { ok: true, listing };
}

async function acceptListing(client, { listingId, guildId, acceptorId, acceptorName, member }) {
  if (!client.barterListingsCollection) return { ok: false, reason: "disabled" };
  const listing = await getListing(client, guildId, listingId);
  if (!listing) return { ok: false, reason: "not_found" };
  if (listing.status !== "active") return { ok: false, reason: "not_active" };
  if (listing.seller_id === acceptorId) return { ok: false, reason: "own_listing" };
  if (new Date(listing.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };

  const offerDef = getItemDef(listing.offer.type, listing.offer.key);
  const wantDef = getItemDef(listing.want.type, listing.want.key);
  if (!offerDef || !wantDef) return { ok: false, reason: "untradeable" };

  // 接受方需具備 want 物品
  const acceptor = await getOrCreate(client, acceptorId, guildId);
  const haveWant = inventory.readQty(acceptor, listing.want.type, listing.want.key);
  if (haveWant < listing.want.qty) {
    return { ok: false, reason: "insufficient_want", have: haveWant, wantDef, need: listing.want.qty };
  }

  // 接受方背包容量檢查（收 offer）
  const recvCheck = await inventory.canReceive(client, acceptorId, guildId, listing.offer.type, listing.offer.qty);
  if (!recvCheck.ok) {
    return { ok: false, reason: "acceptor_full", cap: recvCheck.cap, used: recvCheck.used };
  }

  // 手續費（接受方付）
  const fee = computeFee(offerDef, listing.offer.qty, wantDef, listing.want.qty);
  const balanceDoc = await client.userCoinsCollection.findOne({ userId: acceptorId, guildId }).catch(() => null);
  if (fee > 0 && (balanceDoc?.totalCoins || 0) < fee) {
    return { ok: false, reason: "insufficient_fee", balance: balanceDoc?.totalCoins || 0, fee };
  }

  // 樂觀鎖
  const locked = await client.barterListingsCollection.findOneAndUpdate(
    { guild_id: guildId, listing_id: listingId, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" },
  );
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  // 扣手續費
  if (fee > 0) {
    const debit = await grantCoins(client, {
      userId: acceptorId,
      guildId,
      username: acceptorName,
      member,
      amount: -fee,
      source: "barter_fee",
      meta: { listingId, gross: totalValue(offerDef, listing.offer.qty, wantDef, listing.want.qty) },
    });
    if (!debit) {
      await client.barterListingsCollection.updateOne(
        { guild_id: guildId, listing_id: listingId },
        { $set: { status: "active", updated_at: new Date() } },
      );
      return { ok: false, reason: "grant_failed" };
    }
  }

  // 扣接受方 want
  await inventory.deduct(client, acceptorId, guildId, listing.want.type, listing.want.key, listing.want.qty);
  // 接受方收 offer（從託管）
  await inventory.add(client, acceptorId, guildId, listing.offer.type, listing.offer.key, listing.offer.qty);
  // 賣方收 want
  await inventory.add(client, listing.seller_id, guildId, listing.want.type, listing.want.key, listing.want.qty);

  await client.barterListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    {
      $set: {
        status: "sold",
        buyer_id: acceptorId,
        buyer_name: acceptorName,
        fee,
        settled_at: new Date(),
        updated_at: new Date(),
      },
    },
  );

  if (client.users) {
    const { buildSoldDmMessage } = require("./barterView");
    const dmPayload = buildSoldDmMessage({
      listing: { ...listing, settled_at: new Date() },
      offerDef,
      wantDef,
      acceptorName,
    });
    client.users.fetch(listing.seller_id)
      .then((u) => u.send(dmPayload))
      .catch(() => {});
  }

  return { ok: true, listing, offerDef, wantDef, fee };
}

// cron / lazy：把過期的 active listing 轉成 expired 並退還託管物品
async function sweepExpired(client) {
  if (!client.barterListingsCollection) return { expired: 0 };
  const expired = await client.barterListingsCollection
    .find({ status: "active", expires_at: { $lte: new Date() } })
    .toArray();
  for (const l of expired) {
    const locked = await client.barterListingsCollection.findOneAndUpdate(
      { guild_id: l.guild_id, listing_id: l.listing_id, status: "active" },
      { $set: { status: "expired", settled_at: new Date(), updated_at: new Date() } },
      { returnDocument: "after" },
    );
    if (!(locked?.value || locked)) continue;
    await _refundOffer(client, l, "expired");
  }
  return { expired: expired.length };
}

module.exports = {
  cfg,
  computeFee,
  totalValue,
  createListing,
  listActive,
  listByOwner,
  getListing,
  cancelListing,
  acceptListing,
  sweepExpired,
};
