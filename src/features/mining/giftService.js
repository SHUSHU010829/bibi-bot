require("colors");
const { DateTime } = require("luxon");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { mining, gift, commandChannels, normalChannelId } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { priceOf } = require("./overflowConfirm");
const inventory = require("../barter/inventoryAdapter");
const { getItemDef } = require("../barter/itemCatalog");
const grantCoins = require("../economy/grantCoins");

const TZ = "Asia/Taipei";

// 依物品類型回傳對應頻道的「前往頻道」按鈕；找不到頻道則回 null。
function giftChannelButtonRow(guildId, type) {
  const channelKey =
    type === "fish" ? "fishing" : type === "crop" ? "farm" : "mining";
  const command =
    type === "fish" ? "/魚袋" : type === "crop" ? "/菜園" : "/背包";
  const channelId = commandChannels?.[channelKey]?.[0] || normalChannelId;
  if (!guildId || !channelId) return null;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel(`前往頻道使用 ${command}`)
      .setURL(`https://discord.com/channels/${guildId}/${channelId}`)
  );
}

function giveCfg() {
  return gift || {};
}

function bagPath(type, key) {
  if (type === "ore") return `backpack.${key}`;
  if (type === "crop") return `veggie_bag.${key}`;
  if (type === "fish") return `fish_bag.${key}`;
  return null;
}

function todayISO() {
  return DateTime.now().setZone(TZ).toISODate();
}

// 贈送前的唯讀驗證：不動任何資料。回傳 { ok, itemDef, have, usedToday, dailyMax } 或 { ok:false, reason }。
async function precheckGift(client, { giverId, guildId, type, key, qty }) {
  const c = giveCfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const itemDef = getItemDef(type, key);
  if (!itemDef) return { ok: false, reason: "no_item" };
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

  const have = inventory.readQty(giver, type, key);
  if (have < qty) return { ok: false, reason: "insufficient", have, itemDef };

  return { ok: true, itemDef, have, usedToday, dailyMax };
}

// 託管：扣送禮方的物品 + 消耗當日贈送次數（尚未交付給收禮方）。
// 收禮方按「收下」才 deliverGift；拒收 / 逾時則 refundGift 退回物品與次數。
async function holdGift(client, { giverId, guildId, type, key, qty }) {
  const pre = await precheckGift(client, { giverId, guildId, type, key, qty });
  if (!pre.ok) return pre;

  const today = todayISO();
  await client.miningProfilesCollection.updateOne(
    { userId: giverId, guildId },
    {
      $inc: { [bagPath(type, key)]: -qty },
      $set: { gift_date: today, gift_count: pre.usedToday + 1, updatedAt: new Date() },
    }
  );

  return {
    ok: true,
    itemDef: pre.itemDef,
    usedToday: pre.usedToday + 1,
    dailyMax: pre.dailyMax,
  };
}

// 交付物品給收禮方（收下時呼叫）。礦石若對方背包放不下，溢出折系統收購價金幣。
// 回傳 { ok, itemDef, deliveredQty, overflowQty, overflowCoins }。
async function deliverGift(client, { recipientId, recipientName, guildId, type, key, qty }) {
  const itemDef = getItemDef(type, key);
  if (!itemDef) return { ok: false, reason: "no_item" };

  let deliveredQty = qty;
  let overflowQty = 0;
  if (type === "ore") {
    const recipient = await getOrCreate(client, recipientId, guildId);
    const cap = backpackCapacity(recipient, mining);
    const used = backpackUsed(recipient);
    const space = Math.max(0, cap - used);
    if (used + qty > cap) {
      deliveredQty = space;
      overflowQty = qty - space;
    }
  }
  const overflowCoins = overflowQty > 0 ? priceOf(key) * overflowQty : 0;

  if (deliveredQty > 0) {
    await inventory.add(client, recipientId, guildId, type, key, deliveredQty);
  }
  if (overflowCoins > 0) {
    await grantCoins(client, {
      userId: recipientId,
      guildId,
      username: recipientName,
      amount: overflowCoins,
      source: "gift_overflow",
      meta: { type, key, overflowQty },
    }).catch((e) => console.log(`[ERROR] gift overflow grantCoins: ${e}`.red));
  }

  return { ok: true, itemDef, deliveredQty, overflowQty, overflowCoins };
}

// 退回託管的物品給送禮方（拒收 / 逾時 / 交付失敗時呼叫），並退還當日贈送次數。
async function refundGift(client, { giverId, guildId, type, key, qty }) {
  await inventory.add(client, giverId, guildId, type, key, qty);

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
  precheckGift,
  holdGift,
  deliverGift,
  refundGift,
  giftChannelButtonRow,
};
