require("colors");
const { fishing } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { weightedRandom } = require("../mining/weightedRandom");

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

  // 投竿！依地點加權抽取魚種
  const weights = fishing.dropTable?.[location] || {};
  const fishKey = weightedRandom(weights);
  if (!fishKey) return { ok: false, reason: "no_drop" };

  const fishDef = fishing.fish?.[fishKey] || {};
  const newCooldownAt = now + (fishing.cooldownMs || 9000000);

  const inc = {
    [`fish_bag.${fishKey}`]: 1,
    fish_count_total: 1,
  };
  const set = { fish_cooldown_at: newCooldownAt, updatedAt: new Date() };

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set }
  );

  // 釣魚紀錄（optional，供任務 / 排行榜使用）
  client.fishLogsCollection
    ?.insertOne({ user_id: userId, guild_id: guildId, fish: fishKey, location, ts: new Date() })
    .catch((e) => console.log(`[ERROR] insert fish log: ${e}`.red));

  return {
    ok: true,
    fish: fishKey,
    fishDef,
    location,
    locDef,
    newCooldownAt,
    fishCountTotal: (profile.fish_count_total || 0) + 1,
  };
}

module.exports = { fish, getFishingProfile, locationUnlockDesc };
