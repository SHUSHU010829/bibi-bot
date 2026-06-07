require("colors");
const { DateTime } = require("luxon");
const { mining, gift } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { priceOf } = require("./overflowConfirm");
const inventory = require("../barter/inventoryAdapter");
const { getItemDef } = require("../barter/itemCatalog");
const grantCoins = require("../economy/grantCoins");
const { COIN_EMOJI } = require("../../constants/coin");

const TZ = "Asia/Taipei";

// 對方關閉私訊時靜默失敗，不影響贈送流程。
async function dmRecipient(client, recipientId, content) {
  try {
    const user = await client.users.fetch(recipientId);
    await user.send(content);
  } catch (err) {
    console.log(`[WARN] gift DM 失敗（${recipientId}）：${err?.message || err}`.yellow);
  }
}

function giveCfg() {
  return gift || {};
}

// 贈送物品（礦石 / 作物 / 魚）給其他玩家。
// 無手續費、每日有次數上限、不能送自己。
// allowOverflow=true：對方背包放不下時（僅礦石有容量上限），能放多少放多少，
// 溢出折成系統收購價金幣存入對方錢包。
async function giveItem(
  client,
  { giverId, giverName, guildId, recipientId, recipientName, type, key, qty, allowOverflow = false }
) {
  const c = giveCfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const itemDef = getItemDef(type, key);
  if (!itemDef) return { ok: false, reason: "no_item" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const giver = await getOrCreate(client, giverId, guildId);

  const today = DateTime.now().setZone(TZ).toISODate();
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
  if (have < qty) {
    return { ok: false, reason: "insufficient", have, itemDef };
  }

  // 容量檢查：只有礦石有 slot 上限，作物 / 魚為 map 結構無上限。
  let deliveredQty = qty;
  let overflowQty = 0;
  let cap = 0;
  let used = 0;
  if (type === "ore") {
    const recipient = await getOrCreate(client, recipientId, guildId);
    cap = backpackCapacity(recipient, mining);
    used = backpackUsed(recipient);
    const space = Math.max(0, cap - used);
    if (used + qty > cap) {
      if (!allowOverflow) {
        return { ok: false, reason: "recipient_full", cap, used, itemDef };
      }
      deliveredQty = space;
      overflowQty = qty - space;
    }
  }
  const overflowCoins = overflowQty > 0 ? priceOf(key) * overflowQty : 0;

  await client.miningProfilesCollection.updateOne(
    { userId: giverId, guildId },
    {
      $inc: { [bagPath(type, key)]: -qty },
      $set: { gift_date: today, gift_count: usedToday + 1, updatedAt: new Date() },
    }
  );

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
      meta: { giverId, type, key, overflowQty },
    }).catch((e) => console.log(`[ERROR] gift overflow grantCoins: ${e}`.red));
  }

  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  const guildName = guild?.name || "伺服器";
  const dmLines = [
    `🎁 你在 **${guildName}** 收到一份禮物！`,
    `**${giverName || "某位玩家"}** 送你 **${itemDef.emoji} ${itemDef.name} ×${deliveredQty || qty}**`,
  ];
  if (overflowQty > 0) {
    if (deliveredQty > 0) {
      dmLines.push(
        `🎒 背包只放得下 **${deliveredQty}** 顆，剩下 **${overflowQty}** 顆折成 **+${overflowCoins.toLocaleString()}** ${COIN_EMOJI} 入帳。`,
      );
    } else {
      dmLines.push(
        `🎒 背包已滿，全部折成 **+${overflowCoins.toLocaleString()}** ${COIN_EMOJI} 入帳。`,
      );
    }
  }
  dmRecipient(client, recipientId, dmLines.join("\n"));

  return {
    ok: true,
    type,
    key,
    itemDef,
    qty,
    deliveredQty,
    overflowQty,
    overflowCoins,
    recipientName,
    usedToday: usedToday + 1,
    dailyMax,
  };
}

function bagPath(type, key) {
  if (type === "ore") return `backpack.${key}`;
  if (type === "crop") return `veggie_bag.${key}`;
  if (type === "fish") return `fish_bag.${key}`;
  return null;
}

module.exports = { giveItem };
