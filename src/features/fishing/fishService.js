require("colors");
const { DateTime } = require("luxon");
const { fishing, craft } = require("../../config");
const { getOrCreate, fishBagCapacity, fishBagUsed } = require("../mining/miningProfile");
const { isBagLimitEnforced } = require("../mining/bagStatus");
const { weightedRandom } = require("../mining/weightedRandom");
const {
  getFoodFishBonus,
  consumeFishFortuneUse,
  formatFoodBuffLines,
} = require("./cookService");
const grantCoins = require("../economy/grantCoins");
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

// 成功上鉤時，依機率改抽到「非魚的東西」（垃圾 / 寶物）。
// 釣竿 rareBonus 越高 → 寶物比例越高、垃圾越少。回傳選中的項目（含 category），或 null 表示照常釣魚。
function rollNonFish(rodDef) {
  const cfg = fishing?.nonFishCatch;
  if (!cfg || !(cfg.chance > 0)) return null;
  if (Math.random() >= cfg.chance) return null;

  const treasureChance =
    (cfg.treasureBase || 0) + (rodDef.rareBonus || 0) * (cfg.treasureRodFactor || 0);
  const isTreasure = Math.random() < treasureChance;
  const pool = isTreasure ? cfg.treasure : cfg.junk;
  if (!Array.isArray(pool) || pool.length === 0) return null;

  const weights = {};
  pool.forEach((it, i) => {
    weights[i] = it.weight || 1;
  });
  const item = pool[Number(weightedRandom(weights))];
  if (!item) return null;
  return { ...item, category: isTreasure ? "treasure" : "junk" };
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
async function fish(client, { userId, guildId, location = "stream", member, username }) {
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

  // 魚袋容量：寬限期（bagLimitEnforceAt 未到）只在結果提醒、不擋；
  // 到期後魚袋滿了直接擋下（魚還在水裡、不消耗冷卻，先賣魚再來）。
  const fishCap = fishBagCapacity(profile, fishing);
  const fishUsed = fishBagUsed(profile);
  if (isBagLimitEnforced(fishing.bagLimitEnforceAt) && fishUsed >= fishCap) {
    return { ok: false, reason: "fish_bag_full", used: fishUsed, cap: fishCap };
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
    const failSet = { fish_cooldown_at: failCdAt, last_fish_location: location, updatedAt: new Date() };
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

  // ── 成功上鉤 ──：先算「魚 / 非魚」共用的冷卻、耐久、漁網消耗
  // 冷卻減免（釣竿 + Twitch 訂閱 + 公會建築/等級/宴會 + 世界事件）統一走 buffResolver，與挖礦同構。
  const buffResolver = require("../buff/buffResolver");
  const fishingCd = await buffResolver.getFishingResolve(client, userId, guildId, member, { profile });
  const newCooldownAt = now + fishingCd.actualCdMs;

  const inc = { fish_count_total: 1 };
  if (droppedNetFragment) inc.broken_net_fragments = 1;
  if (netActive) inc.fishing_net_uses = -1;
  const set = { fish_cooldown_at: newCooldownAt, last_fish_location: location, updatedAt: new Date() };

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

  const baseResult = {
    ok: true,
    caught: true,
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
    droppedNetFragment,
    netActive,
    netUsesAfter: netActive ? (profile.fishing_net_uses || 0) - 1 : (profile.fishing_net_uses || 0),
    foodBuffLines: formatFoodBuffLines(profile, "fish"),
  };

  // ── 釣到「非魚的東西」（垃圾 / 寶物）──
  const nonFish = rollNonFish(rodDef);
  if (nonFish) {
    let coinsBase = 0;
    if (Array.isArray(nonFish.coins)) {
      const [lo, hi] = nonFish.coins;
      coinsBase = Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }
    if (nonFish.material) {
      inc[nonFish.material.field] =
        (inc[nonFish.material.field] || 0) + (nonFish.material.qty || 1);
    }

    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: inc, $set: set }
    );
    consumeFortune();

    let coinsAwarded = coinsBase;
    if (coinsBase > 0) {
      const grant = await grantCoins(client, {
        userId,
        guildId,
        username,
        member,
        amount: coinsBase,
        source: "fish_loot",
        meta: { item: nonFish.name, category: nonFish.category },
      }).catch(() => null);
      coinsAwarded = grant?.granted ?? coinsBase;
    }

    bus.emit("fish.done", {
      userId,
      guildId,
      caught: true,
      location,
      fishCountTotal: baseResult.fishCountTotal,
    });
    if (nonFish.material) {
      bus.emit("item.gained", {
        userId,
        guildId,
        itemType: "rare_item",
        itemId: nonFish.material.field,
        qty: nonFish.material.qty || 1,
        source: "fish",
      });
    }

    return {
      ...baseResult,
      nonFish: true,
      catchItem: nonFish,
      coinsAwarded,
      materialReward: nonFish.material
        ? { ...nonFish.material, name: nonFish.name, emoji: nonFish.emoji }
        : null,
    };
  }

  // ── 釣到魚 ──：依稀有度偏移後的權重抽魚
  const rareBonus = (rodDef.rareBonus || 0) + (foodFish.rare || 0);
  const weights = adjustedFishWeights(fishing.dropTable?.[location] || {}, rareBonus);
  const fishKey = weightedRandom(weights);
  if (!fishKey) return { ok: false, reason: "no_drop" };

  const fishDef = fishing.fish?.[fishKey] || {};
  let qty = 1 + (rodDef.qtyBonus || 0);
  // 豐收：依釣竿 bonusChance 機率多釣一條（比照鎬子的數量加成手感）
  let bumperCatch = false;
  if ((rodDef.bonusChance || 0) > 0 && Math.random() < rodDef.bonusChance) {
    qty += 1;
    bumperCatch = true;
  }
  inc[`fish_bag.${fishKey}`] = qty;

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
    fishCountTotal: baseResult.fishCountTotal,
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
    ...baseResult,
    fish: fishKey,
    fishDef,
    qty,
    bumperCatch,
    rareDrops,
    fishBagCap: fishCap,
    fishBagUsed: fishUsed + qty,
  };
}

// 連續釣魚（批次）：一次釣 count 竿，省去逐次點按。與挖礦 mineBatch 同構。
// 第一竿免費（需已過冷卻），之後每竿消耗 1 張 CD 縮短券；釣竿中途壞掉 → 立即停止。
// 重用單次 fish()，所有成功率、耐久、掉落、非魚物、稀有副產物都沿用單次邏輯。
async function fishBatch(client, { userId, guildId, member, username, location = "stream", count, onProgress }) {
  if (!fishing?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const bcfg = fishing?.batch || {};
  if (!bcfg.enabled) return { ok: false, reason: "disabled" };

  const locDef = fishing.locations?.[location];
  if (!locDef) return { ok: false, reason: "invalid_location" };

  const profile = await getFishingProfile(client, userId, guildId);
  const now = Date.now();

  const unlockLevel = bcfg.unlockLevel || 0;
  if (unlockLevel > 0) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId, guildId })
      .catch(() => null);
    const lvl = userLevel?.level ?? 0;
    if (lvl < unlockLevel) {
      return { ok: false, reason: "level_locked", required: unlockLevel, current: lvl };
    }
  }

  // 釣場自身的地下城通關解鎖（熔岩湖需通關 10 次）：先擋，避免半途卡在鎖住的釣場。
  // 等級門檻（海邊 15 / 熔岩湖 40）已被 batch 解鎖等級（100）涵蓋，無需再查。
  if ((locDef.requireDungeonClears || 0) > (profile.dungeon_count || 0)) {
    return {
      ok: false,
      reason: "location_locked",
      locDesc: locationUnlockDesc(location),
      locName: locDef.name || location,
    };
  }

  // CD 縮短券照常規：一張少 cdTicketReductionMs（預設 30 分）。連續釣魚時，每竿前若還在冷卻中，
  // 就依「剩餘冷卻 ÷ 每張券縮短量」無條件進位算出要花幾張券把冷卻清掉再下竿（冷卻 1 小時 → 2 張）。
  const reductionMs = fishing?.cdTicketReductionMs || 1800000;
  const maxCount = Math.max(1, bcfg.maxCount || 1);
  const requested = Math.min(Math.max(1, Math.floor(count || 1)), maxCount);
  const initiallyOnCooldown = (profile.fish_cooldown_at || 0) > now;

  const agg = {
    ok: true,
    location,
    locDef,
    requested,
    maxCount,
    performed: 0,
    ticketsSpent: 0,
    stoppedNoTicket: false,
    caught: 0,
    failed: 0,
    fishByType: {},
    legendaryCount: 0,
    coinsAwarded: 0,
    lootItems: [],
    materials: {},
    rareDrops: {},
    netFragments: 0,
    rodBroke: false,
    rodBrokeFrom: null,
    stoppedLowDurability: false,
    lowDurabilityRod: null,
    stoppedEarly: false,
    newCooldownAt: now,
    fishCountTotal: profile.fish_count_total || 0,
  };

  for (let i = 0; i < requested; i++) {
    const cur = await client.miningProfilesCollection.findOne(
      { userId, guildId },
      { projection: { fish_cooldown_at: 1, cd_ticket_count: 1, fishing_rod: 1, rod_durability: 1 } },
    );

    // 保護性中止：若釣竿再成功釣一次就會斷（耐久 ≤ 1），在斷掉前先停、不下這一竿，
    // 讓釣竿留在耐久 1、不退回竹釣竿。
    if (
      cur?.fishing_rod &&
      cur.fishing_rod !== "bamboo" &&
      typeof cur.rod_durability === "number" &&
      cur.rod_durability <= 1
    ) {
      agg.stoppedLowDurability = true;
      agg.lowDurabilityRod = cur.fishing_rod;
      agg.stoppedEarly = true;
      break;
    }

    const remaining = (cur?.fish_cooldown_at || 0) - Date.now();
    let spentThisIter = 0;
    if (remaining > 0) {
      const need = Math.ceil(remaining / reductionMs);
      if ((cur?.cd_ticket_count || 0) < need) {
        agg.stoppedNoTicket = true;
        break;
      }
      const res = await client.miningProfilesCollection.updateOne(
        { userId, guildId, cd_ticket_count: { $gte: need } },
        { $inc: { cd_ticket_count: -need }, $set: { fish_cooldown_at: 0, updatedAt: new Date() } },
      );
      if (res.modifiedCount === 0) {
        agg.stoppedNoTicket = true;
        break;
      }
      spentThisIter = need;
      agg.ticketsSpent += need;
    }

    const r = await fish(client, { userId, guildId, location, member, username });
    if (!r.ok) {
      if (spentThisIter > 0) {
        await client.miningProfilesCollection
          .updateOne({ userId, guildId }, { $inc: { cd_ticket_count: spentThisIter } })
          .catch(() => {});
        agg.ticketsSpent -= spentThisIter;
      }
      break;
    }

    agg.performed++;
    agg.newCooldownAt = r.newCooldownAt;
    agg.fishCountTotal = r.fishCountTotal;
    if (r.droppedNetFragment) agg.netFragments++;

    let step;
    if (!r.caught) {
      agg.failed++;
      step = { n: agg.performed, kind: "fail" };
    } else if (r.nonFish) {
      agg.coinsAwarded += r.coinsAwarded || 0;
      if (r.catchItem) agg.lootItems.push(r.catchItem.name);
      if (r.materialReward) {
        const key = r.materialReward.field;
        if (!agg.materials[key]) {
          agg.materials[key] = { qty: 0, name: r.materialReward.name, emoji: r.materialReward.emoji };
        }
        agg.materials[key].qty += r.materialReward.qty || 1;
      }
      step = { n: agg.performed, kind: "loot", name: r.catchItem?.name, emoji: r.catchItem?.emoji };
    } else {
      agg.caught++;
      const fkey = r.fish;
      if (!agg.fishByType[fkey]) {
        agg.fishByType[fkey] = { qty: 0, name: r.fishDef?.name || fkey, emoji: r.fishDef?.emoji, rarity: r.fishDef?.rarity };
      }
      agg.fishByType[fkey].qty += r.qty || 1;
      if (r.fishDef?.rarity === "傳說") agg.legendaryCount += 1;
      for (const drop of r.rareDrops || []) {
        const key = drop.field;
        if (!agg.rareDrops[key]) {
          agg.rareDrops[key] = { qty: 0, name: drop.name || drop.item, emoji: drop.emoji };
        }
        agg.rareDrops[key].qty += 1;
      }
      step = {
        n: agg.performed,
        kind: "fish",
        name: r.fishDef?.name || r.fish,
        emoji: r.fishDef?.emoji,
        qty: r.qty || 1,
      };
    }

    if (onProgress) {
      await onProgress({
        performed: agg.performed,
        requested,
        ticketsSpent: agg.ticketsSpent,
        caught: agg.caught,
        failed: agg.failed,
        step,
      }).catch(() => {});
    }

    if (r.rodBroke) {
      agg.rodBroke = true;
      agg.rodBrokeFrom = r.rodKey;
      agg.stoppedEarly = true;
      break;
    }
  }

  if (agg.performed === 0) {
    if (agg.stoppedLowDurability) {
      return { ok: false, reason: "low_durability", rod: agg.lowDurabilityRod };
    }
    return {
      ok: false,
      reason: initiallyOnCooldown ? "cooldown_no_ticket" : "nothing",
      readyAt: profile.fish_cooldown_at,
    };
  }
  return agg;
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

// 判斷某地點對玩家是否已解鎖（等級 + 地下城通關）。
// 供冷卻畫面切換地點時用，避免把鎖住的釣場存成預設。
async function isLocationUnlocked(client, { userId, guildId, location, profile }) {
  const locDef = fishing?.locations?.[location];
  if (!locDef) return false;
  if ((locDef.unlockLevel || 0) > 0) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId, guildId })
      .catch(() => null);
    if ((userLevel?.level ?? 0) < locDef.unlockLevel) return false;
  }
  if ((locDef.requireDungeonClears || 0) > 0) {
    const p = profile || (await getFishingProfile(client, userId, guildId));
    if ((p.dungeon_count || 0) < locDef.requireDungeonClears) return false;
  }
  return true;
}

module.exports = { fish, fishBatch, getFishingProfile, locationUnlockDesc, useCdTicket, isLocationUnlocked };
