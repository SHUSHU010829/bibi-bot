const { getOrCreate, backpackCapacity, backpackUsed } = require("../mining/miningProfile");
const { mining } = require("../../config");

function bagPath(type, key) {
  if (type === "ore") return `backpack.${key}`;
  if (type === "crop") return `veggie_bag.${key}`;
  if (type === "fish") return `fish_bag.${key}`;
  return null;
}

function readQty(profile, type, key) {
  if (!profile) return 0;
  if (type === "ore") return profile.backpack?.[key] || 0;
  if (type === "crop") return profile.veggie_bag?.[key] || 0;
  if (type === "fish") return profile.fish_bag?.[key] || 0;
  return 0;
}

async function deduct(client, userId, guildId, type, key, qty) {
  const path = bagPath(type, key);
  if (!path) return false;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { [path]: -qty }, $set: { updatedAt: new Date() } },
  );
  return true;
}

async function add(client, userId, guildId, type, key, qty) {
  const path = bagPath(type, key);
  if (!path) return false;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { [path]: qty },
      $setOnInsert: { userId, guildId, createdAt: new Date() },
      $set: { updatedAt: new Date() },
    },
    { upsert: true },
  );
  return true;
}

// 接受者收到物品時的容量檢查（目前只有礦石有 slot 上限，作物 / 魚為 map 無上限）。
async function canReceive(client, userId, guildId, type, qty) {
  if (type !== "ore") return { ok: true };
  const profile = await getOrCreate(client, userId, guildId);
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used + qty > cap) return { ok: false, cap, used };
  return { ok: true };
}

module.exports = { readQty, deduct, add, canReceive };
