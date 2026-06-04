require("colors");
const crypto = require("crypto");
const { mining, marketplace } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("../mining/miningProfile");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("../mining/twitchPerks");
const mailbox = require("./marketplaceMailbox");

function cfg() {
  return marketplace || {};
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

// 每人 active 掛單上限（跨所有 type 合計）
async function checkActiveLimit(client, sellerId, guildId) {
  const max = cfg().maxActivePerSeller ?? 8;
  const count = await client.marketListingsCollection.countDocuments({
    guild_id: guildId,
    seller_id: sellerId,
    status: "active",
  });
  return { allowed: count < max, max, count };
}

// ─── 掛牌：賣礦（一口價，收金幣）─────────────────────────────────────────────
async function createSellListing(client, { sellerId, guildId, sellerName, ore, qty, price }) {
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
async function createBarterListing(client, { sellerId, guildId, sellerName, giveOre, giveQty, wantOre, wantQty }) {
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
// payKind: 'coin' | 'ore'
async function createWantListing(client, {
  sellerId, guildId, sellerName,
  wantOre, wantQty,
  payKind, coinAmount, payOre, payQty,
  member,
}) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const wantOreDef = mining?.ores?.[wantOre];
  if (!wantOreDef) return { ok: false, reason: "no_ore" };
  if (!Number.isFinite(wantQty) || wantQty <= 0) return { ok: false, reason: "bad_qty" };

  if (payKind === "coin") {
    if (!Number.isFinite(coinAmount) || coinAmount <= 0)
      return { ok: false, reason: "bad_coin_amount" };
  } else if (payKind === "ore") {
    const payOreDef = mining?.ores?.[payOre];
    if (!payOreDef) return { ok: false, reason: "no_pay_ore" };
    if (payOre === wantOre) return { ok: false, reason: "same_ore" };
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
  let escrowPayOre = null;

  if (payKind === "coin") {
    // 手續費由買方（徵求發起人）支付：託管金額 = coinAmount + fee
    const wantFeeRate = c.wantCoinFeeRate ?? 0.05;
    escrowFee = Math.floor(coinAmount * wantFeeRate);
    const totalEscrow = coinAmount + escrowFee;
    // 先託管金幣，防掛單後金幣被花掉
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
    // 託管付的礦
    const buyer = await getOrCreate(client, sellerId, guildId);
    const have = buyer.backpack?.[payOre] || 0;
    if (have < payQty) {
      return { ok: false, reason: "insufficient", have, oreDef: mining?.ores?.[payOre] };
    }
    await client.miningProfilesCollection.updateOne(
      { userId: sellerId, guildId },
      { $inc: { [`backpack.${payOre}`]: -payQty }, $set: { updatedAt: new Date() } }
    );
    escrowPayOre = { ore: payOre, qty: payQty };
  }

  const doc = {
    listing_id: listingId,
    listing_type: "want",
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    ore: wantOre,
    qty: wantQty,
    pay_kind: payKind,
    pay_coin: payKind === "coin" ? coinAmount : null,
    pay_ore: payKind === "ore" ? payOre : null,
    pay_qty: payKind === "ore" ? payQty : null,
    status: "active",
    escrow_coin: escrowCoin,
    escrow_fee: escrowFee,
    escrow_pay_ore: escrowPayOre,
    created_at: now,
    expires_at: expiresAt,
    updated_at: now,
    settled_at: null,
  };
  await client.marketListingsCollection.insertOne(doc);
  return { ok: true, listing: doc, wantOreDef };
}

// ─── 掛牌：競標──────────────────────────────────────────────────────────────
async function createAuctionListing(client, { sellerId, guildId, sellerName, ore, qty, startPrice, buyoutPrice }) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.marketListingsCollection) return { ok: false, reason: "disabled" };

  const oreDef = mining?.ores?.[ore];
  if (!oreDef) return { ok: false, reason: "no_ore" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const minStart = minAuctionStartPrice(ore);
  if (!Number.isFinite(startPrice) || startPrice < minStart) {
    return { ok: false, reason: "low_start", minStart, oreDef };
  }
  const hasBuyout = buyoutPrice != null;
  if (hasBuyout && (!Number.isFinite(buyoutPrice) || buyoutPrice < startPrice)) {
    return { ok: false, reason: "low_buyout", startPrice, oreDef };
  }

  const limit = await checkActiveLimit(client, sellerId, guildId);
  if (!limit.allowed) return { ok: false, reason: "too_many", max: limit.max };

  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.backpack?.[ore] || 0;
  if (have < qty) return { ok: false, reason: "insufficient", have, oreDef };

  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`backpack.${ore}`]: -qty }, $set: { updatedAt: new Date() } }
  );

  const listingId = await genListingId(client, guildId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (c.durationMs ?? 86400000));
  const doc = {
    listing_id: listingId,
    listing_type: "auction",
    seller_id: sellerId,
    seller_name: sellerName,
    guild_id: guildId,
    ore,
    qty,
    start_price: startPrice,
    buyout_price: hasBuyout ? buyoutPrice : null,
    current_bid: null,
    bidder_id: null,
    bidder_name: null,
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

  // 查買家背包容量
  const buyer = await getOrCreate(client, buyerId, guildId);
  const cap = backpackCapacity(buyer, mining);
  const used = backpackUsed(buyer);
  if (used + listing.qty > cap) {
    return { ok: false, reason: "backpack_full", cap, used };
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

  // 交貨給買家（魚 → fish_bag；礦石 → backpack）
  if (listing.item_type === "fish") {
    await client.miningProfilesCollection.updateOne(
      { userId: buyerId, guildId },
      { $inc: { [`fish_bag.${listing.fish_key}`]: listing.qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] market buyNow deliver fish: ${e}`.red));
  } else {
    await client.miningProfilesCollection.updateOne(
      { userId: buyerId, guildId },
      { $inc: { [`backpack.${listing.ore}`]: listing.qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] market buyNow deliver: ${e}`.red));
  }

  // 標記 sold
  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "sold", fee, proceeds, buyer_id: buyerId, buyer_name: buyerName, settled_at: new Date() } }
  );

  const { fishing } = require("../../config");
  return {
    ok: true,
    listing,
    fee,
    proceeds,
    oreDef: listing.item_type === "fish" ? null : mining?.ores?.[listing.ore],
    fishDef: listing.item_type === "fish" ? fishing?.fish?.[listing.fish_key] : null,
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

// ─── 成交：徵求（賣方提供 want_ore，得到金幣或礦）────────────────────────────
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

  // 賣方持有量（提供 want_ore）
  const seller = await getOrCreate(client, sellerId, guildId);
  const have = seller.backpack?.[listing.ore] || 0;
  if (have < listing.qty) {
    return { ok: false, reason: "insufficient", have, oreDef: mining?.ores?.[listing.ore] };
  }

  // 買方（掛單者）背包容量（收 want_ore）
  const buyer = await getOrCreate(client, listing.seller_id, guildId);
  const buyerCap = backpackCapacity(buyer, mining);
  const buyerUsed = backpackUsed(buyer);
  if (buyerUsed + listing.qty > buyerCap) {
    return { ok: false, reason: "buyer_full", cap: buyerCap, used: buyerUsed };
  }

  // 若付礦，賣方需要有背包空間收付礦
  if (listing.pay_kind === "ore") {
    const sellerCap = backpackCapacity(seller, mining);
    const sellerUsed = backpackUsed(seller);
    if (sellerUsed + listing.pay_qty > sellerCap) {
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

  const c = cfg();

  // 扣賣方提供的礦
  await client.miningProfilesCollection.updateOne(
    { userId: sellerId, guildId },
    { $inc: { [`backpack.${listing.ore}`]: -listing.qty }, $set: { updatedAt: new Date() } }
  ).catch((e) => console.log(`[ERROR] want debit seller ore: ${e}`.red));

  // 給買方（掛單者）want_ore
  await client.miningProfilesCollection.updateOne(
    { userId: listing.seller_id, guildId },
    {
      $inc: { [`backpack.${listing.ore}`]: listing.qty },
      $setOnInsert: { userId: listing.seller_id, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] want deliver buyer: ${e}`.red));

  let fee = 0;
  let proceeds = 0;

  if (listing.pay_kind === "coin") {
    // 手續費已在建單時由買方（徵求發起人）預付託管，賣方拿全額 pay_coin
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
    // 付礦：從託管交給賣方
    await client.miningProfilesCollection.updateOne(
      { userId: sellerId, guildId },
      { $inc: { [`backpack.${listing.pay_ore}`]: listing.pay_qty }, $set: { updatedAt: new Date() } }
    ).catch((e) => console.log(`[ERROR] want deliver pay_ore: ${e}`.red));
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
    wantOreDef: mining?.ores?.[listing.ore],
  };
}

// ─── 競標出價 ────────────────────────────────────────────────────────────────
async function placeBid(client, { listingId, bidderId, guildId, bidderName, member, amount }) {
  const c = cfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
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
    return {
      ok: true,
      buyout: true,
      listing: sale?.listing || doc,
      prevBidderId: prevBidder,
      fee: sale?.fee,
      proceeds: sale?.proceeds,
      oreDef: mining?.ores?.[doc.ore],
    };
  }

  return { ok: true, listing: doc, prevBidderId: prevBidder, oreDef: mining?.ores?.[doc.ore] };
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

  await client.miningProfilesCollection.updateOne(
    { userId: listing.bidder_id, guildId: listing.guild_id },
    {
      $inc: { [`backpack.${listing.ore}`]: listing.qty },
      $setOnInsert: { userId: listing.bidder_id, guildId: listing.guild_id, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true }
  ).catch((e) => console.log(`[ERROR] market auction deliver: ${e}`.red));

  await client.marketListingsCollection.updateOne(
    { listing_id: listing.listing_id, guild_id: listing.guild_id },
    { $set: { status: "sold", fee, proceeds, settled_at: new Date() } }
  );

  // 通知賣家：競標已成交
  const oreDef = mining?.ores?.[listing.ore] || {};
  const oreText = `${oreDef.emoji || "⛏️"} ${oreDef.name || listing.ore} ×${listing.qty}`;
  await dmUser(
    client,
    listing.seller_id,
    `🏷️ 你的競標 **#${listing.listing_id}**（${oreText}）已成交！\n` +
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
  if (!(locked?.value || locked)) return { ok: false, reason: "race" };

  await _refundEscrow(client, listing);

  await client.marketListingsCollection.updateOne(
    { guild_id: guildId, listing_id: listingId },
    { $set: { status: "cancelled", settled_at: new Date() } }
  );
  return { ok: true, listing };
}

// ─── cron 到期結算────────────────────────────────────────────────────────────
async function settleListing(client, listing) {
  const locked = await client.marketListingsCollection.findOneAndUpdate(
    { listing_id: listing.listing_id, guild_id: listing.guild_id, status: "active" },
    { $set: { status: "settling", updated_at: new Date() } },
    { returnDocument: "after" }
  );
  if (!(locked?.value || locked)) return null;

  if (listing.listing_type === "auction" && listing.bidder_id && listing.current_bid) {
    return finalizeAuction(client, listing);
  }

  // 其他 type 或 auction 無人出價 → 退託管
  await _refundEscrow(client, listing);
  await client.marketListingsCollection.updateOne(
    { listing_id: listing.listing_id, guild_id: listing.guild_id },
    { $set: { status: "expired", settled_at: new Date() } }
  );
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
async function createFishSellListing(client, { sellerId, guildId, sellerName, fishKey, qty, price }) {
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

// ─── 查詢────────────────────────────────────────────────────────────────────
async function listActive(client, guildId, { page = 0, pageSize = 5, type = null, itemType = null } = {}) {
  if (!client.marketListingsCollection) return { listings: [], total: 0 };
  const filter = { guild_id: guildId, status: "active" };
  if (type) filter.listing_type = type;
  if (itemType === "fish") {
    filter.item_type = "fish";
  } else if (itemType === "ore") {
    filter.$or = [{ item_type: "ore" }, { item_type: { $exists: false } }];
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

module.exports = {
  createSellListing,
  createFishSellListing,
  createBarterListing,
  createWantListing,
  createAuctionListing,
  buyNow,
  acceptBarter,
  fulfillWant,
  placeBid,
  cancelListing,
  settleListing,
  listActive,
  listByOwner,
  minNextBid,
  dmUser,
  minAuctionStartPrice,
};
