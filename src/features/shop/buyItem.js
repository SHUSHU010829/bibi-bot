require("colors");
const grantCoins = require("../economy/grantCoins");
const { getItem } = require("./catalog");
const { addBuff } = require("./activeBuff");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");

const MINING_ITEM_TYPES = ["mining_luck_potion", "mining_cd_ticket", "mining_backpack"];

// 處理一筆購買：扣款 → 寫入 inventory → 對特殊 type 立即生效（buff/casino_token）
async function buyItem(client, { userId, guildId, username, member, itemId }) {
  const item = getItem(itemId);
  if (!item) return { ok: false, error: "找不到商品" };

  if (!client.userCoinsCollection || !client.userInventoryCollection) {
    return { ok: false, error: "商店系統尚未就緒" };
  }

  if (MINING_ITEM_TYPES.includes(item.type) && !client.miningProfilesCollection) {
    return { ok: false, error: "挖礦系統尚未就緒" };
  }

  // CD 縮短券持有上限：超過上限就拒絕購買（在扣款前檢查）
  if (item.type === "mining_cd_ticket" && item.payload?.maxStack > 0) {
    const prof = await getMiningProfile(client, userId, guildId);
    const owned = prof?.cd_ticket_count || 0;
    const add = item.payload?.qty || 0;
    if (owned + add > item.payload.maxStack) {
      return {
        ok: false,
        error: `CD 縮短券最多持有 ${item.payload.maxStack} 張，你目前已有 ${owned} 張，無法再購買。`,
      };
    }
  }

  const balance = await client.userCoinsCollection
    .findOne({ userId, guildId }, { projection: { totalCoins: 1 } })
    .catch(() => null);
  const totalCoins = balance?.totalCoins || 0;
  if (totalCoins < item.price) {
    return {
      ok: false,
      error: `金幣不足！需要 ${item.price.toLocaleString()}，你只有 ${totalCoins.toLocaleString()}`,
    };
  }

  // 一次性主題：已擁有就拒絕重買
  if (item.type === "wallet_theme") {
    const owned = await client.userInventoryCollection
      .findOne({ userId, guildId, itemId, type: "wallet_theme" })
      .catch(() => null);
    if (owned) return { ok: false, error: "你已經擁有這個主題了" };
  }

  // 期限內非消耗品（role_color / custom_title）：持有未過期同 itemId 就拒絕重買
  if (item.type === "role_color" || item.type === "custom_title") {
    const owned = await client.userInventoryCollection
      .findOne({
        userId,
        guildId,
        itemId,
        type: item.type,
        expired: { $ne: true },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      })
      .catch(() => null);
    if (owned) {
      const expEpoch = owned.expiresAt
        ? Math.floor(new Date(owned.expiresAt).getTime() / 1000)
        : null;
      return {
        ok: false,
        error: expEpoch
          ? `你已持有「${item.name}」，<t:${expEpoch}:R> 才到期，到期前無法重複購買。`
          : `你已持有「${item.name}」。`,
      };
    }
  }

  // 扣款（admin source 會跳過倍率，這裡用 shop_buy 為負值）
  const grant = await grantCoins(client, {
    userId,
    guildId,
    username,
    amount: -item.price,
    source: "shop_buy",
    member,
    meta: { itemId, name: item.name },
  });
  if (!grant) {
    return { ok: false, error: "扣款失敗" };
  }

  const now = new Date();
  const expiresAt =
    item.durationDays && item.durationDays > 0
      ? new Date(now.getTime() + item.durationDays * 24 * 60 * 60 * 1000)
      : null;

  // 寫入背包（buff 類型不需要 inventory，直接生效）
  let inventoryDoc = null;
  if (item.type === "xp_boost" || item.type === "coin_boost") {
    await addBuff(client, {
      userId,
      guildId,
      type: item.type,
      multiplier: item.payload?.multiplier || 1,
      durationMinutes: item.payload?.durationMinutes || 60,
      source: itemId,
    });
  } else if (item.type === "casino_token") {
    // 賭場道具：累計到背包數量
    const tokenName = item.payload?.token;
    const qty = item.payload?.qty || 1;
    inventoryDoc = await client.userInventoryCollection.findOneAndUpdate(
      { userId, guildId, itemId, type: "casino_token", token: tokenName },
      {
        $inc: { qty },
        $set: { updatedAt: now },
        $setOnInsert: {
          userId,
          guildId,
          itemId,
          name: item.name,
          type: "casino_token",
          token: tokenName,
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  } else if (MINING_ITEM_TYPES.includes(item.type)) {
    // 挖礦道具：寫入 MiningProfiles，不進 UserInventory
    await getMiningProfile(client, userId, guildId);
    const incField =
      item.type === "mining_luck_potion"
        ? "luck_potion_uses"
        : item.type === "mining_cd_ticket"
          ? "cd_ticket_count"
          : "backpack_bonus_slots";
    const incAmount =
      item.type === "mining_luck_potion"
        ? item.payload?.uses || 0
        : item.type === "mining_cd_ticket"
          ? item.payload?.qty || 0
          : item.payload?.slots || 0;
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [incField]: incAmount }, $set: { updatedAt: now } },
    );
  } else {
    // role_color / wallet_theme / custom_title：個別建一筆
    inventoryDoc = await client.userInventoryCollection.insertOne({
      userId,
      guildId,
      itemId,
      name: item.name,
      type: item.type,
      payload: item.payload || {},
      equipped: false,
      expiresAt,
      acquiredAt: now,
      updatedAt: now,
    });
  }

  // 交易紀錄
  if (client.shopTransactionsCollection) {
    client.shopTransactionsCollection
      .insertOne({
        userId,
        guildId,
        itemId,
        name: item.name,
        type: item.type,
        price: item.price,
        balanceAfter: grant.doc?.totalCoins || 0,
        createdAt: now,
      })
      .catch((e) => console.log(`[ERROR] insert shop tx: ${e}`.red));
  }

  console.log(
    `[SHOP] ${username || userId} bought ${item.name} (${itemId}) for ${item.price}`.cyan,
  );

  return {
    ok: true,
    item,
    balanceAfter: grant.doc?.totalCoins || 0,
    expiresAt,
    inventoryDoc,
  };
}

module.exports = buyItem;
