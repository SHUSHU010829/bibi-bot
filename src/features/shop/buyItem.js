require("colors");
const { fishing } = require("../../config");
const grantCoins = require("../economy/grantCoins");
const { getItem, isStackable, stackMax } = require("./catalog");
const { getTodayBoughtQty } = require("./dailyLimits");
const { addBuff } = require("./activeBuff");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");
const { getOrCreate: getTheftProfile } = require("../theft/theftProfile");
const { ROD_TIER } = require("../mining/craftService");

const THEFT_ITEM_TYPES = ["theft_watchdog", "theft_safebox", "theft_cloak"];
// 帶持有上限、寫進 TheftProfiles 的防身道具：type → 對應欄位
const THEFT_STACK_LIMIT_MAP = {
  theft_watchdog: "watchdog_count",
  theft_cloak: "night_cloak_count",
};

const MINING_ITEM_TYPES = [
  "mining_luck_potion",
  "mining_cd_ticket",
  "mining_backpack",
  "mining_stamina_potion",
  "mining_stamina_potion_medium",
  "mining_stamina_potion_large",
  "mining_whetstone_inferior",
  "mining_hp_potion_small",
  "mining_hp_potion_medium",
  "mining_hp_potion_large",
];

// 持有上限需在扣款前檢查的挖礦道具：type → 對應 miningProfile 欄位
const MINING_STACK_LIMIT_MAP = {
  mining_cd_ticket: "cd_ticket_count",
  mining_whetstone_inferior: "whetstone_inferior_count",
  mining_stamina_potion: "stamina_potion_count",
  mining_stamina_potion_medium: "stamina_potion_medium_count",
  mining_stamina_potion_large: "stamina_potion_large_count",
  mining_hp_potion_small: "hp_potion_small",
  mining_hp_potion_medium: "hp_potion_medium",
  mining_hp_potion_large: "hp_potion_large",
};

// 每日購買上限的數量單位（純文案用）。
const DAILY_LIMIT_UNIT = {
  mining_cd_ticket: "張",
  mining_stamina_potion: "瓶",
  mining_stamina_potion_medium: "瓶",
  mining_stamina_potion_large: "瓶",
  mining_hp_potion_small: "瓶",
  mining_hp_potion_medium: "瓶",
  mining_hp_potion_large: "瓶",
};

// 處理一筆購買：扣款 → 寫入 inventory → 對特殊 type 立即生效（buff/casino_token）
// quantity 只對可堆疊商品（挖礦道具／賭場代幣）生效，其餘一律當作 1。
// overridePayload：僅 role_color_custom 使用，將自訂 hex 注入 inventory payload。
async function buyItem(client, { userId, guildId, username, member, itemId, quantity = 1, overridePayload }) {
  const item = getItem(itemId);
  if (!item) return { ok: false, error: "找不到商品" };

  if (!client.userCoinsCollection || !client.userInventoryCollection) {
    return { ok: false, error: "商店系統尚未就緒" };
  }

  if ((MINING_ITEM_TYPES.includes(item.type) || item.type === "fishing_rod") && !client.miningProfilesCollection) {
    return { ok: false, error: "挖礦系統尚未就緒" };
  }

  if (THEFT_ITEM_TYPES.includes(item.type) && !client.theftProfilesCollection) {
    return { ok: false, error: "盜賊系統尚未就緒" };
  }

  // 數量：非可堆疊商品強制 1，可堆疊商品夾在 [1, 上限] 內
  let qty = Math.floor(Number(quantity) || 1);
  if (!isStackable(item)) {
    qty = 1;
  } else {
    const max = stackMax(item);
    if (qty < 1) qty = 1;
    if (qty > max) qty = max;
  }

  const totalPrice = item.price * qty;

  // 持有上限檢查：有 payload.maxStack 且對應欄位定義的挖礦道具（在扣款前檢查）
  const stackLimitField = MINING_STACK_LIMIT_MAP[item.type];
  if (stackLimitField && item.payload?.maxStack > 0) {
    const prof = await getMiningProfile(client, userId, guildId);
    const owned = prof?.[stackLimitField] || 0;
    const add = (item.payload?.qty || 0) * qty;
    if (owned + add > item.payload.maxStack) {
      return {
        ok: false,
        error: `「${item.name}」最多持有 ${item.payload.maxStack} 個，你目前已有 ${owned} 個，這次最多再買 ${Math.max(0, item.payload.maxStack - owned)} 個。`,
      };
    }
  }

  // 持有上限檢查：防身道具（看門狗 / 夜行衣）寫進 TheftProfiles
  const theftStackField = THEFT_STACK_LIMIT_MAP[item.type];
  if (theftStackField && item.payload?.maxStack > 0) {
    const prof = await getTheftProfile(client, userId, guildId);
    const owned = prof?.[theftStackField] || 0;
    const add = (item.payload?.qty || 0) * qty;
    if (owned + add > item.payload.maxStack) {
      return {
        ok: false,
        error: `「${item.name}」最多持有 ${item.payload.maxStack} 個，你目前已有 ${owned} 個，這次最多再買 ${Math.max(0, item.payload.maxStack - owned)} 個。`,
      };
    }
  }

  // 每日購買上限（依 Asia/Taipei 跨日重置）：任何帶 payload.dailyLimit 的商品都適用
  if (item.payload?.dailyLimit > 0) {
    const limit = item.payload.dailyLimit;
    const boughtToday = await getTodayBoughtQty(client, { userId, guildId, itemId });
    if (boughtToday + qty > limit) {
      const unit = DAILY_LIMIT_UNIT[item.type] || "個";
      return {
        ok: false,
        error: `「${item.name}」每日最多購買 ${limit} ${unit}，你今天已買 ${boughtToday} ${unit}，今天最多再買 ${Math.max(0, limit - boughtToday)} ${unit}。`,
      };
    }
  }

  // 釣竿：已持有同級或更高階釣竿時拒絕購買（避免降級／浪費），在扣款前檢查
  if (item.type === "fishing_rod") {
    const targetId = item.payload?.rodId;
    if (!targetId || !(fishing?.rods || {})[targetId]) {
      return { ok: false, error: "這個釣竿商品設定有誤，請呼叫舒舒！" };
    }
    const prof = await getMiningProfile(client, userId, guildId);
    const curId = prof?.fishing_rod || "bamboo";
    const curTier = ROD_TIER[curId] ?? 0;
    const targetTier = ROD_TIER[targetId] ?? 0;
    if (curTier >= targetTier) {
      const curName = fishing.rods[curId]?.name || curId;
      return {
        ok: false,
        error: `你目前的釣竿（${curName}）已是同級或更高階，不需要購買。更高階釣竿請用 /合成 打造。`,
      };
    }
  }

  const balance = await client.userCoinsCollection
    .findOne({ userId, guildId }, { projection: { totalCoins: 1 } })
    .catch(() => null);
  const totalCoins = balance?.totalCoins || 0;
  if (totalCoins < totalPrice) {
    return {
      ok: false,
      error: `金幣不足！需要 ${totalPrice.toLocaleString()}，你只有 ${totalCoins.toLocaleString()}`,
    };
  }

  // 一次性主題與等級卡顏色：已擁有就拒絕重買
  if (item.type === "wallet_theme" || item.type === "card_accent") {
    const owned = await client.userInventoryCollection
      .findOne({ userId, guildId, itemId, type: item.type })
      .catch(() => null);
    if (owned) {
      const label = item.type === "card_accent" ? "等級卡顏色" : "主題";
      return { ok: false, error: `你已經擁有這個${label}了` };
    }
  }

  // 期限內非消耗品（role_color / role_color_custom / custom_title）：持有未過期同 itemId 就拒絕重買
  if (item.type === "role_color" || item.type === "role_color_custom" || item.type === "custom_title") {
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
    amount: -totalPrice,
    source: "shop_buy",
    member,
    meta: { itemId, name: item.name, quantity: qty },
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
    const tokenQty = (item.payload?.qty || 1) * qty;
    inventoryDoc = await client.userInventoryCollection.findOneAndUpdate(
      { userId, guildId, itemId, type: "casino_token", token: tokenName },
      {
        $inc: { qty: tokenQty },
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
  } else if (item.type === "fishing_rod") {
    // 釣竿：直接裝備到 MiningProfiles（含耐久），不進 UserInventory
    await getMiningProfile(client, userId, guildId);
    const rodId = item.payload.rodId;
    const dura = (fishing.rods[rodId]?.durability) ?? null;
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      {
        $set: {
          fishing_rod: rodId,
          rod_durability: dura,
          rod_max_durability: dura,
          updatedAt: now,
        },
      },
    );
  } else if (MINING_ITEM_TYPES.includes(item.type)) {
    // 挖礦道具：寫入 MiningProfiles，不進 UserInventory
    await getMiningProfile(client, userId, guildId);
    // 各道具型別對應的 profile 欄位與 payload 中的單位數量鍵
    const MINING_FIELD_MAP = {
      mining_luck_potion: { field: "luck_potion_uses", payloadKey: "uses" },
      mining_cd_ticket:   { field: "cd_ticket_count",  payloadKey: "qty"  },
      mining_backpack:    { field: "backpack_bonus_slots", payloadKey: "slots" },
      mining_whetstone_inferior: { field: "whetstone_inferior_count", payloadKey: "qty" },
      mining_stamina_potion: { field: "stamina_potion_count", payloadKey: "qty" },
      mining_stamina_potion_medium: { field: "stamina_potion_medium_count", payloadKey: "qty" },
      mining_stamina_potion_large: { field: "stamina_potion_large_count", payloadKey: "qty" },
      mining_hp_potion_small: { field: "hp_potion_small", payloadKey: "qty" },
      mining_hp_potion_medium: { field: "hp_potion_medium", payloadKey: "qty" },
      mining_hp_potion_large: { field: "hp_potion_large", payloadKey: "qty" },
    };
    const mapping = MINING_FIELD_MAP[item.type];
    const incField = mapping?.field || "luck_potion_uses";
    const incAmount = (item.payload?.[mapping?.payloadKey] || 0) * qty;
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [incField]: incAmount }, $set: { updatedAt: now } },
    );
  } else if (THEFT_ITEM_TYPES.includes(item.type)) {
    // 防身道具：寫入 TheftProfiles，不進 UserInventory
    const prof = await getTheftProfile(client, userId, guildId);
    if (item.type === "theft_safebox") {
      // 保險箱是限時效果：時效內重購則從現有到期時間往後延長
      const durMs = (item.payload?.durationMinutes || 0) * 60 * 1000;
      const base = Math.max(Date.now(), prof?.safebox_expires_at || 0);
      await client.theftProfilesCollection.updateOne(
        { userId, guildId },
        { $set: { safebox_expires_at: base + durMs, updatedAt: now } },
      );
    } else {
      const field = THEFT_STACK_LIMIT_MAP[item.type];
      const incAmount = (item.payload?.qty || 0) * qty;
      await client.theftProfilesCollection.updateOne(
        { userId, guildId },
        { $inc: { [field]: incAmount }, $set: { updatedAt: now } },
      );
    }
  } else {
    // role_color / role_color_custom / wallet_theme / custom_title / card_accent：個別建一筆
    inventoryDoc = await client.userInventoryCollection.insertOne({
      userId,
      guildId,
      itemId,
      name: item.name,
      type: item.type,
      payload: overridePayload || item.payload || {},
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
        quantity: qty,
        unitPrice: item.price,
        price: totalPrice,
        balanceAfter: grant.doc?.totalCoins || 0,
        createdAt: now,
      })
      .catch((e) => console.log(`[ERROR] insert shop tx: ${e}`.red));
  }

  console.log(
    `[SHOP] ${username || userId} bought ${item.name} (${itemId}) x${qty} for ${totalPrice}`.cyan,
  );

  return {
    ok: true,
    item,
    quantity: qty,
    totalPrice,
    balanceAfter: grant.doc?.totalCoins || 0,
    expiresAt,
    inventoryDoc,
  };
}

module.exports = buyItem;
