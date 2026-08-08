require("colors");
const { DateTime } = require("luxon");
const { mining, gift } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { priceOf } = require("./overflowConfirm");
const itemRegistry = require("../economy/itemRegistry");
const grantCoins = require("../economy/grantCoins");

const TZ = "Asia/Taipei";

function giveCfg() {
  return gift || {};
}

function todayISO() {
  return DateTime.now().setZone(TZ).toISODate();
}

// offer.item 早期只存 { type, key }（那時只送得出礦石／作物／魚），
// 現在一律存 registry value；讀舊資料時補回來。
function offerValue(item) {
  return item?.value || itemRegistry.bagValue(item?.type, item?.key);
}

// 待收訊息用的中文品名。查不到定義（物品下架）也不會印出英文 id。
function offerLabel(item) {
  return itemRegistry.labelOf(offerValue(item)) || "❔ 已下架物品";
}

// 贈送前的唯讀驗證：不動任何資料。
// 回傳 { ok, item, label, have, usedToday, dailyMax } 或 { ok:false, reason }。
async function precheckGift(client, { giverId, guildId, value, qty }) {
  const c = giveCfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const item = itemRegistry.resolve(value);
  if (!item) return { ok: false, reason: "no_item" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const giver = await getOrCreate(client, giverId, guildId);
  const today = todayISO();
  const usedToday = giver.gift_date === today ? giver.gift_count || 0 : 0;
  const dailyMax = c.dailyMaxGives ?? 3;
  if (usedToday >= dailyMax) {
    const resetAt = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf("day");
    return {
      ok: false,
      reason: "daily_limit",
      usedToday,
      dailyMax,
      resetEpoch: Math.floor(resetAt.toSeconds()),
    };
  }

  const have = itemRegistry.ownedQty(giver, value);
  if (have < qty) return { ok: false, reason: "insufficient", have, item, label: item.label };

  return { ok: true, item, label: item.label, have, usedToday, dailyMax };
}

// 託管：扣送禮方的物品 + 消耗當日贈送次數（尚未交付給收禮方）。
// 收禮方按「收下」才 deliverGift；拒收 / 逾時則 refundGift 退回物品與次數。
// 食物一併把被扣掉的份數（instances）帶回來，退回時新鮮度才不會被重置。
async function holdGift(client, { giverId, guildId, value, qty }) {
  const pre = await precheckGift(client, { giverId, guildId, value, qty });
  if (!pre.ok) return pre;

  let instances = null;
  if (pre.item.kind === "food") {
    const taken = await itemRegistry.takeFood(client, giverId, guildId, value, qty);
    if (!taken.ok) return { ok: false, reason: "insufficient", have: pre.have, item: pre.item, label: pre.label };
    instances = taken.instances;
  } else if (!(await itemRegistry.take(client, giverId, guildId, value, qty))) {
    return { ok: false, reason: "insufficient", have: pre.have, item: pre.item, label: pre.label };
  }

  await client.miningProfilesCollection.updateOne(
    { userId: giverId, guildId },
    {
      $set: { gift_date: todayISO(), gift_count: pre.usedToday + 1, updatedAt: new Date() },
    }
  );

  return {
    ok: true,
    item: pre.item,
    label: pre.label,
    instances,
    usedToday: pre.usedToday + 1,
    dailyMax: pre.dailyMax,
  };
}

// 交付物品給收禮方（收下時呼叫）。礦石若對方背包放不下，溢出折系統收購價金幣
// （只有礦石占背包格數，其餘物品沒有容量問題）。
// 回傳 { ok, label, deliveredQty, overflowQty, overflowCoins }。
async function deliverGift(client, { recipientId, recipientName, guildId, value, qty, instances }) {
  const item = itemRegistry.resolve(value);
  if (!item) return { ok: false, reason: "no_item" };

  // 先確保收禮方的 profile 存在且欄位齊全，避免 grant 的 upsert 生出殘缺文件。
  const recipient = await getOrCreate(client, recipientId, guildId);

  let deliveredQty = qty;
  let overflowQty = 0;
  if (item.kind === "bag" && item.type === "ore") {
    const cap = backpackCapacity(recipient, mining);
    const used = backpackUsed(recipient);
    const space = Math.max(0, cap - used);
    if (used + qty > cap) {
      deliveredQty = space;
      overflowQty = qty - space;
    }
  }
  const overflowCoins = overflowQty > 0 ? priceOf(item.key) * overflowQty : 0;

  if (deliveredQty > 0) {
    if (item.kind === "food" && instances?.length) {
      await itemRegistry.grantFood(client, recipientId, guildId, instances);
    } else {
      await itemRegistry.grant(client, recipientId, guildId, value, deliveredQty);
    }
  }
  if (overflowCoins > 0) {
    await grantCoins(client, {
      userId: recipientId,
      guildId,
      username: recipientName,
      amount: overflowCoins,
      source: "gift_overflow",
      meta: { value, overflowQty },
    }).catch((e) => console.log(`[ERROR] gift overflow grantCoins: ${e}`.red));
  }

  return { ok: true, item, label: item.label, deliveredQty, overflowQty, overflowCoins };
}

// 退回託管的物品給送禮方（拒收 / 逾時 / 交付失敗時呼叫），並退還當日贈送次數。
async function refundGift(client, { giverId, guildId, value, qty, instances }) {
  const item = itemRegistry.resolve(value);
  if (item?.kind === "food" && instances?.length) {
    await itemRegistry.grantFood(client, giverId, guildId, instances);
  } else {
    await itemRegistry.grant(client, giverId, guildId, value, qty);
  }

  const giver = await client.miningProfilesCollection
    .findOne({ userId: giverId, guildId })
    .catch(() => null);
  if (giver && giver.gift_date === todayISO() && (giver.gift_count || 0) > 0) {
    await client.miningProfilesCollection.updateOne(
      { userId: giverId, guildId },
      { $inc: { gift_count: -1 }, $set: { updatedAt: new Date() } }
    );
  }
  return { ok: true };
}

module.exports = {
  offerValue,
  offerLabel,
  precheckGift,
  holdGift,
  deliverGift,
  refundGift,
};
