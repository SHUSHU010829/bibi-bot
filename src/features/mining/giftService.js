require("colors");
const { DateTime } = require("luxon");
const { mining, auction } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");

const TZ = "Asia/Taipei";

function giveCfg() {
  return auction?.give || {};
}

// 贈送礦石給其他玩家（無手續費、每日有次數上限、不能送自己）。
async function giveOre(
  client,
  { giverId, guildId, recipientId, recipientName, ore, qty }
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
  if (used + qty > cap) {
    return { ok: false, reason: "recipient_full", cap, used };
  }

  // 扣送禮者背包 + 累加每日次數
  await client.miningProfilesCollection.updateOne(
    { userId: giverId, guildId },
    {
      $inc: { [`backpack.${ore}`]: -qty },
      $set: { gift_date: today, gift_count: usedToday + 1, updatedAt: new Date() },
    }
  );

  // 加收禮者背包
  await client.miningProfilesCollection.updateOne(
    { userId: recipientId, guildId },
    { $inc: { [`backpack.${ore}`]: qty }, $set: { updatedAt: new Date() } }
  );

  return {
    ok: true,
    ore,
    oreDef,
    qty,
    recipientName,
    usedToday: usedToday + 1,
    dailyMax,
  };
}

module.exports = { giveOre };
