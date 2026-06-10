require("colors");
const { DateTime } = require("luxon");
const { fishing, craft } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");
const { weightedRandom } = require("../mining/weightedRandom");
const {
  getFoodFishBonus,
  consumeFishFortuneUse,
  formatFoodBuffLines,
} = require("./cookService");
const bus = require("../eventBus");

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
    const today = DateTime.now().setZone("Asia/Taipei").toISODate();
    const dailyLimit = fishing?.cdTicketDailyUseLimit || 0;
    const usedToday =
      profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;
    return {
      ok: false,
      reason: "cooldown",
      remainingMs: profile.fish_cooldown_at - now,
      readyAt: profile.fish_cooldown_at,
      cdTickets: profile.cd_ticket_count || 0,
      cdTicketUsedToday: usedToday,
      cdTicketDailyLimit: dailyLimit,
      cdTicketReductionMs: fishing?.cdTicketReductionMs || 0,
      rodKey: profile.fishing_rod || "bamboo",
      rodDurability: profile.rod_durability,
      rodMaxDurability: profile.rod_max_durability,
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
  const netActive = (profile.fishing_net_uses || 0) > 0;
  const netBonus = netActive ? (craft?.fishingNet?.successBonus ?? 0.1) : 0;
  // 世界事件「漁港補給」buff：整數百分比 → 小數
  const worldEventBuffs = require("../world_event/worldEventBuffs");
  const worldFishSuccess = (worldEventBuffs.getCachedBuffs().fishing_success_rate_pct || 0) / 100;
  const successRate = Math.min(
    cap,
    base + (rodDef.successBonus || 0) + (foodFish.success || 0) + netBonus + worldFishSuccess
  );

  // 釣魚計次都會消耗一次 fish_fortune（不論成功失敗），手感 buff 是「次數制」
  const consumeFortune = () =>
    consumeFishFortuneUse(client, userId, guildId, profile).catch(() => {});

  // 損壞漁網碎片：每次釣魚（不論成敗）固定機率掉
  const netFragChance = craft?.fishingNet?.dropChancePerFish ?? 0;
  const droppedNetFragment = netFragChance > 0 && Math.random() < netFragChance;

  // 成功判定
  if (Math.random() >= successRate) {
    // 失敗：魚跑了，套用較短的失敗冷卻，不扣釣竿耐久；撈網不扣使用次數
    const failCdAt = now + (fishing.failCooldownMs || 1800000);
    const failSet = { fish_cooldown_at: failCdAt, updatedAt: new Date() };
    const failInc = {};
    if (droppedNetFragment) failInc.broken_net_fragments = 1;
    const updateOps = { $set: failSet };
    if (Object.keys(failInc).length > 0) updateOps.$inc = failInc;
    await client.miningProfilesCollection.updateOne({ userId, guildId }, updateOps);
    consumeFortune();
    bus.emit("fish.done", {
      userId,
      guildId,
      caught: false,
      location,
      fishCountTotal: profile.fish_count_total || 0,
    });
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
      droppedNetFragment,
      netActive,
      foodBuffLines: formatFoodBuffLines(profile, "fish"),
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
  if (droppedNetFragment) inc.broken_net_fragments = 1;
  if (netActive) inc.fishing_net_uses = -1;
  const set = { fish_cooldown_at: newCooldownAt, updatedAt: new Date() };

  // 釣竿耐久：非竹竿且有耐久值才消耗；歸 0 退回竹竿（比照鎬子）
  let rodBroke = false;
  let rodDurabilityAfter = null;
  let rodDurabilityWarnCrossed = null;
  const hasDurability =
    rodKey !== "bamboo" && typeof profile.rod_durability === "number";
  if (hasDurability) {
    const before = profile.rod_durability;
    rodDurabilityAfter = before - 1;
    if (rodDurabilityAfter <= 0) {
      rodBroke = true;
      rodDurabilityAfter = null;
      set.fishing_rod = "bamboo";
      set.rod_durability = null;
      set.rod_max_durability = null;
    } else {
      inc.rod_durability = -1;
      const warn = fishing?.durabilityWarn || {};
      if (typeof warn.critical === "number" && before > warn.critical && rodDurabilityAfter <= warn.critical) {
        rodDurabilityWarnCrossed = "critical";
      } else if (typeof warn.low === "number" && before > warn.low && rodDurabilityAfter <= warn.low) {
        rodDurabilityWarnCrossed = "low";
      }
    }
  }

  // 稀有道具掉落（例如熔岩湖的月光露水）
  const rareDrops = [];
  for (const drop of fishing.rareItemDrops?.[location] || []) {
    if (Math.random() < (drop.chance || 0)) {
      inc[drop.field] = (inc[drop.field] || 0) + 1;
      rareDrops.push(drop);
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

  const newFishCountTotal = (profile.fish_count_total || 0) + 1;

  // 世界事件觸發 roll：fire-and-forget
  require("../world_event/worldEventService")
    .rollTrigger(client, "fish_catch", { fish: fishKey })
    .catch(() => {});

  bus.emit("fish.done", {
    userId,
    guildId,
    caught: true,
    fish: fishKey,
    location,
    fishCountTotal: newFishCountTotal,
  });
  bus.emit("item.gained", {
    userId,
    guildId,
    itemType: "fish",
    itemId: fishKey,
    qty,
    source: "fish",
  });
  for (const drop of rareDrops) {
    bus.emit("item.gained", {
      userId,
      guildId,
      itemType: "rare_item",
      itemId: drop.field,
      qty: 1,
      source: "fish",
    });
  }

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
    rodDurabilityWarnCrossed,
    newCooldownAt,
    fishCountTotal: (profile.fish_count_total || 0) + 1,
    rareDrops,
    droppedNetFragment,
    netActive,
    netUsesAfter: netActive ? (profile.fishing_net_uses || 0) - 1 : (profile.fishing_net_uses || 0),
    foodBuffLines: formatFoodBuffLines(profile, "fish"),
  };
}

// 冷卻中主動使用一張 CD 縮短券：直接縮短目前的釣魚冷卻。
// 與挖礦共用 cd_ticket_count 庫存與 cd_ticket_used_* 每日計數，
// 縮短量取 fishing.cdTicketReductionMs（預設 30 分），不足則歸零。
async function useCdTicket(client, { userId, guildId }) {
  if (!fishing?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  if ((profile.cd_ticket_count || 0) <= 0) {
    return { ok: false, reason: "no_ticket" };
  }
  if ((profile.fish_cooldown_at || 0) <= now) {
    return { ok: false, reason: "not_in_cooldown" };
  }

  const today = DateTime.now().setZone("Asia/Taipei").toISODate();
  const dailyLimit = fishing?.cdTicketDailyUseLimit || 0;
  const usedToday =
    profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;
  if (dailyLimit > 0 && usedToday >= dailyLimit) {
    return { ok: false, reason: "daily_limit", limit: dailyLimit };
  }

  const reductionMs = fishing?.cdTicketReductionMs || 0;
  const newCooldownAt = Math.max(now, profile.fish_cooldown_at - reductionMs);
  const clearedToReady = newCooldownAt <= now;

  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      cd_ticket_count: { $gte: 1 },
      fish_cooldown_at: { $gt: now },
    },
    [
      {
        $set: {
          cd_ticket_count: { $add: ["$cd_ticket_count", -1] },
          fish_cooldown_at: newCooldownAt,
          cd_ticket_used_date: today,
          cd_ticket_used_count: {
            $cond: [
              { $eq: ["$cd_ticket_used_date", today] },
              { $add: [{ $ifNull: ["$cd_ticket_used_count", 0] }, 1] },
              1,
            ],
          },
          updatedAt: "$$NOW",
        },
      },
    ]
  );

  if (res.modifiedCount === 0) {
    return { ok: false, reason: "retry" };
  }

  return {
    ok: true,
    clearedToReady,
    newCooldownAt,
    ticketsLeft: (profile.cd_ticket_count || 0) - 1,
    usedToday: usedToday + 1,
    dailyLimit,
    rodKey: profile.fishing_rod || "bamboo",
    rodDurability: profile.rod_durability,
    rodMaxDurability: profile.rod_max_durability,
  };
}

module.exports = { fish, getFishingProfile, locationUnlockDesc, useCdTicket };
