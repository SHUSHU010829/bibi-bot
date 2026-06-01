require("colors");
const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { weightedRandom } = require("../mining/weightedRandom");
const {
  getFoodFishBonus,
  consumeFishFortuneUse,
} = require("./cookService");

// 依 rareBonus 調整後的掉落權重：weight * (1 + rareBonus * rareFactor)。
// 比照挖礦的 dropTable.adjustedWeights，讓更好的釣竿 / 海鮮拼盤偏向稀有魚。
function adjustedFishWeights(locWeights, rareBonus = 0) {
  const weights = {};
  for (const [key, base] of Object.entries(locWeights || {})) {
    const factor = fishing?.fish?.[key]?.rareFactor || 0;
    weights[key] = base * (1 + rareBonus * factor);
  }
  return weights;
}

// 釣魚核心服務。CD 與魚袋存於 MiningProfiles，與挖礦系統共用玩家文件。
// 回傳結果物件交由指令層呈現。

async function getFishingProfile(client, userId, guildId) {
  return getOrCreate(client, userId, guildId);
}

// 取得某地點的解鎖需求說明文字（供錯誤訊息使用）
function locationUnlockDesc(locKey) {
  const loc = fishing?.locations?.[locKey];
  if (!loc) return locKey;
  const parts = [];
  if (loc.unlockLevel > 0) parts.push(`等級 ${loc.unlockLevel}`);
  if (loc.requireDungeonClears > 0) parts.push(`地下城通關 ${loc.requireDungeonClears} 次`);
  return parts.join(" + ") || "預設解鎖";
}

// 執行一次釣魚。回傳結果物件。
async function fish(client, { userId, guildId, location = "stream" }) {
  if (!fishing?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const locDef = fishing.locations?.[location];
  if (!locDef) return { ok: false, reason: "invalid_location" };

  const profile = await getFishingProfile(client, userId, guildId);
  const now = Date.now();

  // CD 檢查
  if ((profile.fish_cooldown_at || 0) > now) {
    return {
      ok: false,
      reason: "cooldown",
      remainingMs: profile.fish_cooldown_at - now,
      readyAt: profile.fish_cooldown_at,
    };
  }

  // 等級解鎖：查 UserLevels
  const userLevel = await client.userLevelsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  const playerLevel = userLevel?.level ?? 0;

  if (playerLevel < (locDef.unlockLevel || 0)) {
    return {
      ok: false,
      reason: "level_locked",
      required: locDef.unlockLevel,
      current: playerLevel,
      locDesc: locationUnlockDesc(location),
    };
  }

  // 地下城通關數解鎖（熔岩湖）
  if ((locDef.requireDungeonClears || 0) > 0) {
    const dungeonClears = profile.dungeon_count || 0;
    if (dungeonClears < locDef.requireDungeonClears) {
      return {
        ok: false,
        reason: "dungeon_locked",
        required: locDef.requireDungeonClears,
        current: dungeonClears,
        locDesc: locationUnlockDesc(location),
      };
    }
  }

  // 釣竿 + 海鮮拼盤（fish_fortune）：決定成功率與稀有度偏移
  const rods = fishing.rods || {};
  const rodKey = profile.fishing_rod || "bamboo";
  const rodDef = rods[rodKey] || rods.bamboo || {};
  const foodFish = getFoodFishBonus(profile); // { success, rare }

  const base = fishing.baseSuccessRate ?? 0.6;
  const cap = fishing.successCap ?? 0.95;
  const successRate = Math.min(
    cap,
    base + (rodDef.successBonus || 0) + (foodFish.success || 0)
  );

  // 釣魚計次都會消耗一次 fish_fortune（不論成功失敗），手感 buff 是「次數制」
  const consumeFortune = () =>
    consumeFishFortuneUse(client, userId, guildId, profile).catch(() => {});

  // 成功判定
  if (Math.random() >= successRate) {
    // 失敗：魚跑了，套用較短的失敗冷卻，不扣釣竿耐久
    const failCdAt = now + (fishing.failCooldownMs || 1800000);
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $set: { fish_cooldown_at: failCdAt, updatedAt: new Date() } }
    );
    consumeFortune();
    return {
      ok: true,
      caught: false,
      location,
      locDef,
      rodKey,
      rodDef,
      successRate,
      newCooldownAt: failCdAt,
      fishCountTotal: profile.fish_count_total || 0,
    };
  }

  // 成功！依稀有度偏移後的權重抽魚
  const rareBonus = (rodDef.rareBonus || 0) + (foodFish.rare || 0);
  const weights = adjustedFishWeights(fishing.dropTable?.[location] || {}, rareBonus);
  const fishKey = weightedRandom(weights);
  if (!fishKey) return { ok: false, reason: "no_drop" };

  const fishDef = fishing.fish?.[fishKey] || {};
  const qty = 1 + (rodDef.qtyBonus || 0);
  const newCooldownAt =
    now + Math.max((fishing.cooldownMs || 9000000) - (rodDef.cdReductionMs || 0), 60 * 1000);

  const inc = {
    [`fish_bag.${fishKey}`]: qty,
    fish_count_total: 1,
  };
  const set = { fish_cooldown_at: newCooldownAt, updatedAt: new Date() };

  // 釣竿耐久：非竹竿且有耐久值才消耗；歸 0 退回竹竿（比照鎬子）
  let rodBroke = false;
  let rodDurabilityAfter = null;
  const hasDurability =
    rodKey !== "bamboo" && typeof profile.rod_durability === "number";
  if (hasDurability) {
    rodDurabilityAfter = profile.rod_durability - 1;
    if (rodDurabilityAfter <= 0) {
      rodBroke = true;
      rodDurabilityAfter = null;
      set.fishing_rod = "bamboo";
      set.rod_durability = null;
      set.rod_max_durability = null;
    } else {
      inc.rod_durability = -1;
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set }
  );

  consumeFortune();

  // 釣魚紀錄（optional，供任務 / 排行榜使用）
  client.fishLogsCollection
    ?.insertOne({ user_id: userId, guild_id: guildId, fish: fishKey, location, ts: new Date() })
    .catch((e) => console.log(`[ERROR] insert fish log: ${e}`.red));

  return {
    ok: true,
    caught: true,
    fish: fishKey,
    fishDef,
    qty,
    location,
    locDef,
    rodKey,
    rodDef,
    successRate,
    rodBroke,
    rodDurabilityAfter,
    newCooldownAt,
    fishCountTotal: (profile.fish_count_total || 0) + 1,
  };
}

module.exports = { fish, getFishingProfile, locationUnlockDesc };
