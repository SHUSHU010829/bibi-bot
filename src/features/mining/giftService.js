require("colors");
const { DateTime } = require("luxon");
const { mining, auction } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { priceOf } = require("./overflowConfirm");
const grantCoins = require("../economy/grantCoins");

const TZ = "Asia/Taipei";

function giveCfg() {
  return auction?.give || {};
}

// 贈送礦石給其他玩家（無手續費、每日有次數上限、不能送自己）。
// allowOverflow=true：對方背包放不下時，能放多少放多少，溢出折成金幣存入對方錢包。
async function giveOre(
  client,
  { giverId, guildId, recipientId, recipientName, ore, qty, allowOverflow = false }
) {
  const c = giveCfg();
  if (!mining?.enabled || !c.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const oreDef = mining?.ores?.[ore];
  if (!oreDef) return { ok: false, reason: "no_ore" };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, reason: "bad_qty" };

  const giver = await getOrCreate(client, giverId, guildId);

  // 每日次數
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

  const have = giver.backpack?.[ore] || 0;
  if (have < qty) {
    return { ok: false, reason: "insufficient", have, oreDef };
  }

  // 收禮者容量檢查
  const recipient = await getOrCreate(client, recipientId, guildId);
  const cap = backpackCapacity(recipient, mining);
  const used = backpackUsed(recipient);
  const space = Math.max(0, cap - used);
  let deliveredQty = qty;
  let overflowQty = 0;
  if (used + qty > cap) {
    if (!allowOverflow) {
      return { ok: false, reason: "recipient_full", cap, used };
    }
    deliveredQty = space;
    overflowQty = qty - space;
  }
  const overflowCoins = overflowQty > 0 ? priceOf(ore) * overflowQty : 0;

  // 扣送禮者背包 + 累加每日次數
  await client.miningProfilesCollection.updateOne(
    { userId: giverId, guildId },
    {
      $inc: { [`backpack.${ore}`]: -qty },
      $set: { gift_date: today, gift_count: usedToday + 1, updatedAt: new Date() },
    }
  );

  // 加收禮者背包（能塞多少塞多少）
  if (deliveredQty > 0) {
    await client.miningProfilesCollection.updateOne(
      { userId: recipientId, guildId },
      { $inc: { [`backpack.${ore}`]: deliveredQty }, $set: { updatedAt: new Date() } }
    );
  }

  // 溢出折金幣給「收禮人」
  if (overflowCoins > 0) {
    await grantCoins(client, {
      userId: recipientId,
      guildId,
      username: recipientName,
      amount: overflowCoins,
      source: "gift_overflow",
      meta: { giverId, ore, overflowQty },
    }).catch((e) => console.log(`[ERROR] gift overflow grantCoins: ${e}`.red));
  }

  return {
    ok: true,
    ore,
    oreDef,
    qty,
    deliveredQty,
    overflowQty,
    overflowCoins,
    recipientName,
    usedToday: usedToday + 1,
    dailyMax,
  };
}

module.exports = { giveOre };
