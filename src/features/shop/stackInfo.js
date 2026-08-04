const { stackMax } = require("./catalog");
const { getTodayBoughtQty } = require("./dailyLimits");
const { getOrCreate: getMiningProfile } = require("../mining/miningProfile");
const backpackExpansion = require("./backpackExpansion");

// 可堆疊商品 type → 玩家「目前持有」要查的 miningProfile 欄位、單位、payload 數量鍵。
// payloadKey 是「每買一筆實際增加幾個」的來源（持有上限與今日進度都以此單位計）。
const OWNED_FIELD = {
  mining_cd_ticket: { field: "cd_ticket_count", unit: "張", payloadKey: "qty" },
  mining_whetstone_inferior: { field: "whetstone_inferior_count", unit: "個", payloadKey: "qty" },
  mining_stamina_potion: { field: "stamina_potion_count", unit: "瓶", payloadKey: "qty" },
  mining_stamina_potion_medium: { field: "stamina_potion_medium_count", unit: "瓶", payloadKey: "qty" },
  mining_stamina_potion_large: { field: "stamina_potion_large_count", unit: "瓶", payloadKey: "qty" },
  mining_hp_potion_small: { field: "hp_potion_small", unit: "瓶", payloadKey: "qty" },
  mining_hp_potion_medium: { field: "hp_potion_medium", unit: "瓶", payloadKey: "qty" },
  mining_hp_potion_large: { field: "hp_potion_large", unit: "瓶", payloadKey: "qty" },
  mining_luck_potion: { field: "luck_potion_uses", unit: "次", payloadKey: "uses" },
  mining_backpack: { field: "backpack_bonus_slots", unit: "格", payloadKey: "slots" },
};

// 查詢可堆疊商品的購買限制資訊：單次上限、持有上限、目前持有、今日已購、本次最多可買筆數。
// 給「輸入數量 Modal」顯示用；真正的扣款上限仍以 buyItem 的檢查為準。
async function getStackInfo(client, { userId, guildId, item }) {
  const max = stackMax(item); // 單次購買上限（筆）
  const maxStack = item.payload?.maxStack > 0 ? item.payload.maxStack : null; // 持有上限
  const dailyLimit = item.payload?.dailyLimit > 0 ? item.payload.dailyLimit : null;

  const meta = OWNED_FIELD[item.type];
  const isBuffPotion = item.type === "xp_boost" || item.type === "coin_boost";
  const unit = meta?.unit || (isBuffPotion ? "瓶" : "個");
  const perQty = (meta && item.payload?.[meta.payloadKey]) || 1;

  let owned = null;
  if (item.type === "casino_token") {
    const doc = await client.userInventoryCollection
      .findOne({ userId, guildId, itemId: item.id, type: "casino_token", token: item.payload?.token })
      .catch(() => null);
    owned = doc?.qty || 0;
  } else if (meta) {
    const prof = await getMiningProfile(client, userId, guildId).catch(() => null);
    owned = prof?.[meta.field] || 0;
  }

  let boughtToday = 0;
  if (dailyLimit != null) {
    boughtToday = await getTodayBoughtQty(client, { userId, guildId, itemId: item.id });
  }

  // 背包擴充：可買筆數由硬上限與最近一道未達成的門檻決定，並帶出下一筆的實際價格。
  if (item.type === "mining_backpack") {
    const prof = await getMiningProfile(client, userId, guildId).catch(() => null);
    const q = backpackExpansion.quote(prof, 1, item);
    const allowed = await backpackExpansion.maxChunksNow(client, { userId, guildId, profile: prof, item });
    return {
      max,
      maxStack: null,
      dailyLimit: null,
      unit,
      owned,
      boughtToday: 0,
      perQty,
      maxBuyNow: Math.min(max, allowed),
      capacity: q.capacityBefore,
      capacityMax: backpackExpansion.maxSlots(),
      nextPrice: q.nextPrice,
    };
  }

  let maxBuyNow = max;
  if (maxStack != null && owned != null) {
    maxBuyNow = Math.min(maxBuyNow, Math.max(0, Math.floor((maxStack - owned) / perQty)));
  }
  if (dailyLimit != null) {
    maxBuyNow = Math.min(maxBuyNow, Math.max(0, dailyLimit - boughtToday));
  }

  return { max, maxStack, dailyLimit, unit, owned, boughtToday, perQty, maxBuyNow };
}

module.exports = { getStackInfo };
