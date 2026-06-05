require("colors");
const crypto = require("crypto");
const { fishing } = require("../../config");

// 食物倉庫（食物 instance 陣列）+ 新鮮度衰減 + 過期變堆肥。
//
// food_bag instance 結構：
//   { id, recipeId, cookedAt, useCoal }
//   - id:        本地隨機 ID（用於按鈕 customId / DB $pull 鎖定）
//   - cookedAt:  ms timestamp，烹飪當下記下，之後不再變
//   - useCoal:   煤炭烤製版（時間軸 ×config.coalMultiplier）
//
// 衰減曲線（線性，無地板）：
//   0 ─ freshUntilMs        ：100%
//   freshUntilMs ─ zeroAtMs ：100% → 0%
//   > zeroAtMs              ：0%（讀取時 lazy 移除 → 自動轉成廚餘堆肥）
//
// 套用 buff 時 value = baseValue × freshness；duration / uses 不衰減。

function defaults() {
  return fishing?.foodStorage || {
    freshUntilMs: 43200000,
    zeroAtMs: 604800000,
    coalMultiplier: 1.5,
  };
}

function newId() {
  return crypto.randomBytes(4).toString("hex");
}

function effectiveAgeBounds(useCoal) {
  const cfg = defaults();
  const m = useCoal ? (cfg.coalMultiplier || 1.5) : 1;
  return {
    freshUntil: (cfg.freshUntilMs || 0) * m,
    zeroAt: (cfg.zeroAtMs || 0) * m,
  };
}

// 0..1。已腐壞回 0；尚未開始衰減回 1。
function freshness(instance, now = Date.now()) {
  if (!instance?.cookedAt) return 0;
  const age = now - instance.cookedAt;
  if (age <= 0) return 1;
  const { freshUntil, zeroAt } = effectiveAgeBounds(!!instance.useCoal);
  if (age <= freshUntil) return 1;
  if (age >= zeroAt) return 0;
  const span = zeroAt - freshUntil;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - (age - freshUntil) / span));
}

// 取出新鮮度 > 0 的食物（已過期的不算）；each instance 加上 freshness 欄位
function listFresh(profile, now = Date.now()) {
  const bag = Array.isArray(profile?.food_bag) ? profile.food_bag : [];
  return bag
    .map((it) => ({ ...it, freshness: freshness(it, now) }))
    .filter((it) => it.freshness > 0);
}

// 找出已腐壞的 instance（freshness = 0）。
function listSpoiled(profile, now = Date.now()) {
  const bag = Array.isArray(profile?.food_bag) ? profile.food_bag : [];
  return bag.filter((it) => freshness(it, now) === 0);
}

// 同食譜分組，並以 freshness 由低到高排序（先讓玩家用快壞的）。
function groupByRecipe(items) {
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.recipeId)) groups.set(it.recipeId, []);
    groups.get(it.recipeId).push(it);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.freshness - b.freshness);
  }
  return groups;
}

// 清掉所有已腐壞的食物，並把每份轉成 1 份廚餘堆肥。
// 回傳 { removed: number }。若沒東西要清就不寫 DB。
async function sweepSpoiled(client, userId, guildId, profile) {
  const spoiled = listSpoiled(profile);
  if (spoiled.length === 0) return { removed: 0 };
  const ids = spoiled.map((it) => it.id);
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $pull: { food_bag: { id: { $in: ids } } },
      $inc: { "backpack.compost": spoiled.length },
      $set: { updatedAt: new Date() },
    }
  );
  return { removed: spoiled.length };
}

// 新增一份食物到倉庫。
async function addFood(client, userId, guildId, { recipeId, useCoal }) {
  const instance = {
    id: newId(),
    recipeId,
    cookedAt: Date.now(),
    useCoal: !!useCoal,
  };
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $push: { food_bag: instance },
      $set: { updatedAt: new Date() },
    }
  );
  return instance;
}

// 從倉庫移除一份食物（依 instanceId）。回傳是否實際移除。
async function removeFood(client, userId, guildId, instanceId) {
  const res = await client.miningProfilesCollection.updateOne(
    { userId, guildId, "food_bag.id": instanceId },
    {
      $pull: { food_bag: { id: instanceId } },
      $set: { updatedAt: new Date() },
    }
  );
  return res.modifiedCount > 0;
}

module.exports = {
  newId,
  freshness,
  listFresh,
  listSpoiled,
  groupByRecipe,
  sweepSpoiled,
  addFood,
  removeFood,
};
