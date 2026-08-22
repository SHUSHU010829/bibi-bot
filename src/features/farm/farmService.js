require("colors");
const { farming } = require("../../config");
const { getOrCreate, veggieBagCapacity, veggieBagUsed } = require("../mining/miningProfile");
const { isBagLimitEnforced } = require("../mining/bagStatus");
const grantCoins = require("../economy/grantCoins");
const grantActivityXp = require("../leveling/grantActivityXp");
const trapTiers = require("./trapTiers");
const {
  getFoodFarmYieldBonus,
  consumeFarmYieldUse,
  consumeFarmYieldUses,
} = require("../fishing/cookService");
const buildingService = require("../guild_club/buildingService");
const swordBreakService = require("../dungeon/swordBreakService");
const bus = require("../eventBus");

const LOW_TIER_CROPS = new Set(["carrot", "corn"]);

// 農場核心服務。每塊地以 (userId, guildId, plotIndex) 唯一存於 FarmPlots。
//
// 狀態流：
//   growing  → ready  → rotted              （未施肥或正常老化）
//   growing/ready → raided                  （隨機被怪物偷襲，最少種下 minElapsedMs 後）
//   raided   → growing/ready/null           （防禦勝→回原狀態；敗→作物毀）
//
// 成長時間縮短累計上限：farming.growthReductionCapPct（預設 60%）。

function randInt(min, max) {
  const lo = Math.ceil(min ?? 0);
  const hi = Math.floor(max ?? lo);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

// 種植時一次性擲骰決定「這批作物會不會、以及何時」被入侵：以 raid.chance 機率排定一個
// 落在 [種下 + minElapsedMs, 凋萎前] 的 raid_at；沒中就回 null（這批完全不會有怪物）。
// 之後任何讀取路徑到時間才把它「兌現」成入侵（見 applyPendingRaids），不再每次開農場重擲，
// 所以看幾次都不影響命運，也無法用 /收成 繞過。
function rollRaidAt(plantedAt, expiresAt) {
  const raidCfg = farming?.raid;
  if (!raidCfg) return null;
  if (Math.random() >= (raidCfg.chance ?? 0)) return null;
  const minElapsed = raidCfg.minElapsedMs ?? 30 * 60 * 1000;
  const start = plantedAt + minElapsed;
  if (expiresAt <= start) return null;
  return start + Math.floor(Math.random() * (expiresAt - start));
}

function coll(client) {
  return client?.farmPlotsCollection || null;
}

// 取得玩家目前的地塊上限（從 profile 讀取，預設 2）
function getPlotCount(profile) {
  return Math.max(1, Math.min(profile?.farm_plot_count || 2, farming?.maxPlots || 8));
}

// 取出所有地塊狀態（含空地塊）。回傳 plotIndex 對應的物件。
async function getPlots(client, userId, guildId, plotCount) {
  const c = coll(client);
  if (!c) return [];
  const docs = await c.find({ userId, guildId }).toArray().catch(() => []);
  const map = new Map(docs.map((d) => [d.plotIndex, d]));
  const out = [];
  for (let i = 0; i < plotCount; i++) {
    out.push(map.get(i) || { plotIndex: i, status: "empty", crop: null });
  }
  return out;
}

// 即時推算狀態（不寫庫）：若到了 ready_at / expires_at 應切換為 ready / rotted。
// 用於 UI 顯示，避免依賴 cron 才生效。
function resolveLiveStatus(plot, now = Date.now()) {
  if (!plot || plot.status === "empty" || !plot.crop) return plot;
  if (plot.status === "rotted" || plot.status === "raided") return plot;
  if (plot.status === "growing" && plot.ready_at && now >= plot.ready_at) {
    return { ...plot, status: "ready" };
  }
  if ((plot.status === "growing" || plot.status === "ready") && plot.expires_at && now >= plot.expires_at) {
    return { ...plot, status: "rotted" };
  }
  return plot;
}

// 種植：依作物 seedKey/seedOptional 決定扣幣或扣種子，寫入 FarmPlots。
// - 沒 seedKey（紅蘿蔔、玉米）：純扣 plantCost。
// - seedKey + seedOptional（草莓）：有種子→扣 1 顆免幣；沒種子→扣 plantCost。
// - seedKey 必填（黑玫瑰）：沒種子直接擋；有種子→扣 1 顆 + 仍扣 plantCost。
async function plantCrop(client, { userId, guildId, username, member, cropKey, plotIndex }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const crop = farming.crops?.[cropKey];
  if (!crop) return { ok: false, reason: "invalid_crop" };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  if (plotIndex < 0 || plotIndex >= plotCount) {
    return { ok: false, reason: "invalid_plot", plotCount };
  }

  const existing = await coll(client).findOne({ userId, guildId, plotIndex }).catch(() => null);
  if (existing && existing.status !== "empty" && existing.status !== "rotted") {
    return { ok: false, reason: "plot_occupied", existing };
  }

  let seedConsumed = false;
  if (crop.seedKey) {
    const seedQty = profile.seed_bag?.[crop.seedKey] || 0;
    if (seedQty >= 1) {
      seedConsumed = true;
    } else if (!crop.seedOptional) {
      return { ok: false, reason: "missing_seed", seedKey: crop.seedKey };
    }
  }

  const coinsNeeded = seedConsumed && crop.seedOptional ? 0 : (crop.plantCost || 0);

  if (coinsNeeded > 0) {
    const coinDoc = await client.userCoinsCollection
      ?.findOne({ userId, guildId })
      .catch(() => null);
    const have = coinDoc?.totalCoins || 0;
    if (have < coinsNeeded) {
      return { ok: false, reason: "insufficient_coins", need: coinsNeeded, have };
    }
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: -coinsNeeded,
      source: "farm_plant",
      meta: { crop: cropKey, plotIndex, seedConsumed },
    });
  }

  if (seedConsumed) {
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: { [`seed_bag.${crop.seedKey}`]: -1 }, $set: { updatedAt: new Date() } },
    );
  }

  // 公會農膳坊：種植時即套用一次成長時間減免，計入與肥料共用的 cap。
  const buildingBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const growthCutPct = buildingBuffs.farm_growth_reduction_pct || 0;
  const cap = farming.growthReductionCapPct ?? 0.6;
  const maxReduction = Math.floor((crop.growMs || 0) * cap);
  const buildingReductionMs = Math.min(
    maxReduction,
    Math.floor((crop.growMs || 0) * (growthCutPct / 100))
  );

  const now = Date.now();
  const ready_at = now + (crop.growMs - buildingReductionMs);
  const expires_at = ready_at + crop.rotMs;
  const plotDoc = {
    userId, guildId, plotIndex,
    crop: cropKey,
    planted_at: now,
    ready_at,
    expires_at,
    fertilizers: [],
    growth_reduction_ms: buildingReductionMs,
    yield_bonus_pct: 0,
    status: "growing",
    raid: null,
    raid_at: rollRaidAt(now, expires_at),
    updatedAt: new Date(),
  };
  await coll(client).updateOne(
    { userId, guildId, plotIndex },
    { $set: plotDoc },
    { upsert: true },
  );

  // 累計種植次數
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: { farm_count_total: 1 } },
  ).catch(() => {});

  return { ok: true, plot: plotDoc, crop, seedConsumed, coinsPaid: coinsNeeded };
}

// 一鍵種植：把同一種作物種在所有空地（含已枯萎），扣不夠時自然停止。
// 共用資料（profile、建築 buff、金幣、種子）只查一次，於記憶體結算後批次寫入，
// 避免逐塊重複查庫 / 逐塊 grantCoins 造成 8 塊地要跑數十次 DB 來回。
async function plantAllCrops(client, { userId, guildId, username, member, cropKey }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const crop = farming.crops?.[cropKey];
  if (!crop) return { ok: false, reason: "invalid_crop" };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  const plots = await getPlots(client, userId, guildId, plotCount);
  const targets = plots
    .filter((p) => !p.crop || p.status === "empty" || p.status === "rotted")
    .map((p) => p.plotIndex);

  if (targets.length === 0) {
    return { ok: false, reason: "no_empty_plot" };
  }

  // 公會農膳坊成長減免：整批共用同一份 buff。
  const buildingBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const growthCutPct = buildingBuffs.farm_growth_reduction_pct || 0;
  const cap = farming.growthReductionCapPct ?? 0.6;
  const maxReduction = Math.floor((crop.growMs || 0) * cap);
  const buildingReductionMs = Math.min(
    maxReduction,
    Math.floor((crop.growMs || 0) * (growthCutPct / 100)),
  );

  const now = Date.now();
  const ready_at = now + (crop.growMs - buildingReductionMs);
  const expires_at = ready_at + crop.rotMs;

  // 種子與金幣在記憶體結算：逐塊決定扣種子或扣幣，超出預算即停。
  let seedRemaining = crop.seedKey ? (profile.seed_bag?.[crop.seedKey] || 0) : 0;
  const coinDoc = await client.userCoinsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  let coinsRemaining = coinDoc?.totalCoins || 0;

  const plantedIndexes = [];
  let totalCoinsPaid = 0;
  let totalSeedsUsed = 0;
  let stopReason = null;
  for (const plotIndex of targets) {
    let seedConsumed = false;
    if (crop.seedKey) {
      if (seedRemaining >= 1) {
        seedConsumed = true;
      } else if (!crop.seedOptional) {
        stopReason = { reason: "missing_seed", seedKey: crop.seedKey };
        break;
      }
    }
    const coinsNeeded = seedConsumed && crop.seedOptional ? 0 : (crop.plantCost || 0);
    if (coinsNeeded > coinsRemaining) {
      stopReason = { reason: "insufficient_coins", need: coinsNeeded, have: coinsRemaining };
      break;
    }
    if (seedConsumed) { seedRemaining -= 1; totalSeedsUsed += 1; }
    coinsRemaining -= coinsNeeded;
    totalCoinsPaid += coinsNeeded;
    plantedIndexes.push(plotIndex);
  }

  if (plantedIndexes.length === 0) {
    return {
      ok: false,
      reason: stopReason?.reason || "plant_failed",
      planted: [],
      crop,
      stopReason,
      totalTargets: targets.length,
      totalCoinsPaid: 0,
      totalSeedsUsed: 0,
    };
  }

  const planted = plantedIndexes.map((plotIndex) => ({
    userId, guildId, plotIndex,
    crop: cropKey,
    planted_at: now,
    ready_at,
    expires_at,
    fertilizers: [],
    growth_reduction_ms: buildingReductionMs,
    yield_bonus_pct: 0,
    status: "growing",
    raid: null,
    raid_at: rollRaidAt(now, expires_at),
    updatedAt: new Date(),
  }));

  await coll(client).bulkWrite(
    planted.map((doc) => ({
      updateOne: {
        filter: { userId, guildId, plotIndex: doc.plotIndex },
        update: { $set: doc },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const profileInc = { farm_count_total: planted.length };
  if (totalSeedsUsed > 0) profileInc[`seed_bag.${crop.seedKey}`] = -totalSeedsUsed;
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: profileInc, $set: { updatedAt: new Date() } },
  );

  if (totalCoinsPaid > 0) {
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: -totalCoinsPaid,
      source: "farm_plant",
      meta: { crop: cropKey, plots: plantedIndexes, count: planted.length },
    });
  }

  return {
    ok: true,
    reason: null,
    planted,
    crop,
    stopReason,
    totalTargets: targets.length,
    totalCoinsPaid,
    totalSeedsUsed,
  };
}

// 收成：依 yield_bonus_pct 計算金幣產出、寫入 veggie_bag，並依作物配置抽 bonusDrops。
async function harvestCrop(client, { userId, guildId, username, member, plotIndex }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const plot = await coll(client).findOne({ userId, guildId, plotIndex }).catch(() => null);
  if (!plot || plot.status === "empty" || !plot.crop) {
    return { ok: false, reason: "empty_plot" };
  }

  // 收成前先兌現待處理的入侵：raid_at 已到就翻成 raided，擋下這次收成，
  // 讓玩家無法用 /收成 繞過怪物（觸發與 /農場 查看 完全一致）。
  const profileForBuff = await getOrCreate(client, userId, guildId);
  await applyPendingRaids(client, { userId, guildId, plots: [plot], profile: profileForBuff });

  const live = resolveLiveStatus(plot);
  if (live.status === "rotted") {
    // 直接清掉爛掉的地塊
    await coll(client).deleteOne({ userId, guildId, plotIndex });
    return { ok: false, reason: "rotted", crop: plot.crop };
  }
  if (live.status === "raided") {
    return { ok: false, reason: "under_raid", plot: live };
  }
  if (live.status !== "ready") {
    return { ok: false, reason: "not_ready", plot: live, readyAt: plot.ready_at };
  }

  const crop = farming.crops?.[plot.crop];
  if (!crop) return { ok: false, reason: "invalid_crop" };

  const [lo, hi] = crop.payout || [0, 0];
  const baseCoins = randInt(lo, hi);

  // 菜籃容量：寬限期（bagLimitEnforceAt 未到）只在結果提醒、不擋；
  // 到期後菜籃滿了擋下收成（作物留在地塊，先賣菜再收）。
  const veggieCap = veggieBagCapacity(profileForBuff, farming);
  const veggieUsedNow = veggieBagUsed(profileForBuff);
  if (isBagLimitEnforced(farming.bagLimitEnforceAt) && veggieUsedNow >= veggieCap) {
    return { ok: false, reason: "veggie_bag_full", used: veggieUsedNow, cap: veggieCap, crop: plot.crop };
  }
  const fertBonus = plot.yield_bonus_pct || 0;
  const foodBonus = getFoodFarmYieldBonus(profileForBuff);
  // 世界事件「草莓教祭典」buff：farm_yield_pct（整數百分比） + farm_yield_count_bonus（+N 個）
  const worldEventBuffs = require("../world_event/worldEventBuffs");
  const worldBuffs = worldEventBuffs.getCachedBuffs();
  const worldYieldPct = (worldBuffs.farm_yield_pct || 0) / 100;
  const worldYieldCountBonus = worldBuffs.farm_yield_count_bonus || 0;
  // 公會農膳坊：收成金幣 +X%（只動幣，不動掉率）+ 低階作物 +1 個（限紅蘿蔔/玉米）
  const buildingBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const harvestCoinPct = (buildingBuffs.harvest_coin_pct || 0) / 100;
  const lowTierExtra = LOW_TIER_CROPS.has(plot.crop)
    ? buildingBuffs.farm_low_tier_extra_count || 0
    : 0;
  const yieldBonus = fertBonus + foodBonus + worldYieldPct;
  const coins = Math.round(baseCoins * (1 + yieldBonus) * (1 + harvestCoinPct));

  // 寫入 veggie_bag（含世界事件「+1 個」加成 + 農膳坊「低階作物 +1」）
  const harvestCount = 1 + worldYieldCountBonus + lowTierExtra;
  const inc = { [`veggie_bag.${plot.crop}`]: harvestCount, farm_harvest_total: 1 };

  // 額外掉落（黑玫瑰）
  const bonusDropsResult = [];
  for (const drop of crop.bonusDrops || []) {
    if (Math.random() < (drop.chance || 0)) {
      const amount = drop.amount || 1;
      if (drop.kind === "fragment") {
        inc.legendary_fragments = (inc.legendary_fragments || 0) + amount;
        bonusDropsResult.push({ kind: "fragment", amount });
      } else if (drop.kind === "rare_bait") {
        inc.rare_bait = (inc.rare_bait || 0) + amount;
        bonusDropsResult.push({ kind: "rare_bait", amount });
      }
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  // 發幣
  if (coins > 0) {
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: coins,
      source: "farm_harvest",
      meta: { crop: plot.crop, plotIndex, yieldBonus, fertilizers: plot.fertilizers },
    });
  }

  // 清除地塊
  await coll(client).deleteOne({ userId, guildId, plotIndex });

  const xpGained = await grantActivityXp(client, "farm", {
    userId, guildId, username, member,
    meta: { crop: plot.crop },
  });

  // 消耗一次 farm_yield buff（若有的話）
  if (foodBonus > 0) {
    consumeFarmYieldUse(client, userId, guildId, profileForBuff).catch(() => {});
  }

  // 世界事件觸發 roll：fire-and-forget
  require("../world_event/worldEventService")
    .rollTrigger(client, "farm_harvest", { crop: plot.crop })
    .catch(() => {});

  bus.emit("harvest.done", {
    userId,
    guildId,
    crop: plot.crop,
    coins,
    plotIndex,
  });
  bus.emit("item.gained", {
    userId,
    guildId,
    itemType: "veggie",
    itemId: plot.crop,
    qty: harvestCount,
    source: "harvest",
  });
  for (const drop of bonusDropsResult) {
    bus.emit("item.gained", {
      userId,
      guildId,
      itemType: drop.kind,
      itemId: drop.kind,
      qty: drop.amount,
      source: "harvest",
    });
  }

  return {
    ok: true,
    crop: plot.crop,
    cropDef: crop,
    coins,
    baseCoins,
    yieldBonus,
    fertBonus,
    foodBonus,
    harvestCount,
    worldYieldCountBonus,
    bonusDrops: bonusDropsResult,
    fertilizers: plot.fertilizers || [],
    veggieBagCap: veggieCap,
    veggieBagUsed: veggieUsedNow + harvestCount,
    xpGained,
  };
}

// 一鍵收成：把所有成熟地塊一次結算。共用資料（profile、建築 buff、食物 / 世界事件 buff）
// 只算一次，逐塊在記憶體累加收益後，批次刪地塊 + 一次寫 profile + 一次 grantCoins，
// 避免逐塊各自 getOrCreate / getMemberBuildingBuffs / grantCoins 的數十次 DB 來回。
async function harvestAllCrops(client, { userId, guildId, username, member }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled", results: [] };
  if (!coll(client)) return { ok: false, reason: "disabled", results: [] };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  const plots = await getPlots(client, userId, guildId, plotCount);
  const now = Date.now();
  // 一鍵收成同樣先兌現入侵：被翻成 raided 的地塊會自然被下面的 ready 篩選排除，收不到。
  await applyPendingRaids(client, { userId, guildId, plots, profile, now });
  const readyPlots = plots
    .map((p) => resolveLiveStatus(p, now))
    .filter((p) => p.status === "ready");

  if (readyPlots.length === 0) {
    return { ok: false, reason: "no_ready_plot", results: [] };
  }

  const foodBonus = getFoodFarmYieldBonus(profile);
  const worldEventBuffs = require("../world_event/worldEventBuffs");
  const worldBuffs = worldEventBuffs.getCachedBuffs();
  const worldYieldPct = (worldBuffs.farm_yield_pct || 0) / 100;
  const worldYieldCountBonus = worldBuffs.farm_yield_count_bonus || 0;
  const buildingBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const harvestCoinPct = (buildingBuffs.harvest_coin_pct || 0) / 100;

  const veggieCap = veggieBagCapacity(profile, farming);
  let veggieUsed = veggieBagUsed(profile);
  const enforceBag = isBagLimitEnforced(farming.bagLimitEnforceAt);

  const results = [];
  const inc = {};
  const deleteIndexes = [];
  let totalCoins = 0;
  let bagFull = null;

  for (const live of readyPlots) {
    if (enforceBag && veggieUsed >= veggieCap) {
      bagFull = { reason: "veggie_bag_full", used: veggieUsed, cap: veggieCap, crop: live.crop };
      break;
    }
    const crop = farming.crops?.[live.crop];
    if (!crop) continue;

    const [lo, hi] = crop.payout || [0, 0];
    const baseCoins = randInt(lo, hi);
    const fertBonus = live.yield_bonus_pct || 0;
    const lowTierExtra = LOW_TIER_CROPS.has(live.crop)
      ? buildingBuffs.farm_low_tier_extra_count || 0
      : 0;
    const yieldBonus = fertBonus + foodBonus + worldYieldPct;
    const coins = Math.round(baseCoins * (1 + yieldBonus) * (1 + harvestCoinPct));
    const harvestCount = 1 + worldYieldCountBonus + lowTierExtra;

    inc[`veggie_bag.${live.crop}`] = (inc[`veggie_bag.${live.crop}`] || 0) + harvestCount;
    inc.farm_harvest_total = (inc.farm_harvest_total || 0) + 1;

    const bonusDropsResult = [];
    for (const drop of crop.bonusDrops || []) {
      if (Math.random() < (drop.chance || 0)) {
        const amount = drop.amount || 1;
        if (drop.kind === "fragment") {
          inc.legendary_fragments = (inc.legendary_fragments || 0) + amount;
          bonusDropsResult.push({ kind: "fragment", amount });
        } else if (drop.kind === "rare_bait") {
          inc.rare_bait = (inc.rare_bait || 0) + amount;
          bonusDropsResult.push({ kind: "rare_bait", amount });
        }
      }
    }

    totalCoins += coins;
    veggieUsed += harvestCount;
    deleteIndexes.push(live.plotIndex);
    results.push({
      ok: true,
      crop: live.crop,
      cropDef: crop,
      coins,
      baseCoins,
      yieldBonus,
      fertBonus,
      foodBonus,
      harvestCount,
      worldYieldCountBonus,
      bonusDrops: bonusDropsResult,
      fertilizers: live.fertilizers || [],
      veggieBagCap: veggieCap,
      veggieBagUsed: veggieUsed,
      plotIndex: live.plotIndex,
    });
  }

  if (results.length === 0) {
    return { ok: false, reason: bagFull ? "veggie_bag_full" : "harvest_failed", bagFull, results: [] };
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );
  await coll(client).bulkWrite(
    deleteIndexes.map((plotIndex) => ({ deleteOne: { filter: { userId, guildId, plotIndex } } })),
    { ordered: false },
  );

  if (totalCoins > 0) {
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: totalCoins,
      source: "farm_harvest",
      meta: { plots: deleteIndexes, count: results.length },
    });
  }

  // 一鍵收成：每塊各自 roll 基礎經驗、加總後一次授予，避免逐塊打 UserLevels 熱點文件
  // （比照連續挖礦 / 釣魚的 deferXp 匯總）。
  let xpBase = 0;
  for (let i = 0; i < results.length; i += 1) xpBase += grantActivityXp.roll("farm");
  const xpGained = await grantActivityXp(client, "farm", {
    userId, guildId, username, member,
    amount: xpBase,
    meta: { count: results.length },
  });

  if (foodBonus > 0) {
    consumeFarmYieldUses(client, userId, guildId, profile, results.length).catch(() => {});
  }

  const worldEventService = require("../world_event/worldEventService");
  for (const r of results) {
    worldEventService.rollTrigger(client, "farm_harvest", { crop: r.crop }).catch(() => {});
    bus.emit("harvest.done", { userId, guildId, crop: r.crop, coins: r.coins, plotIndex: r.plotIndex });
    bus.emit("item.gained", { userId, guildId, itemType: "veggie", itemId: r.crop, qty: r.harvestCount, source: "harvest" });
    for (const drop of r.bonusDrops) {
      bus.emit("item.gained", { userId, guildId, itemType: drop.kind, itemId: drop.kind, qty: drop.amount, source: "harvest" });
    }
  }

  return { ok: true, results, bagFull, xpGained };
}

// 一鍵清除所有已枯萎地塊：以即時狀態判定，包含尚未被 cron 寫成 rotted、但 expires_at 已過的作物。
async function clearRottedCrops(client, { userId, guildId }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled", cleared: [] };
  if (!coll(client)) return { ok: false, reason: "disabled", cleared: [] };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  const plots = await getPlots(client, userId, guildId, plotCount);
  const now = Date.now();
  const rottedPlots = plots
    .map((p) => resolveLiveStatus(p, now))
    .filter((p) => p.crop && p.status === "rotted");

  if (rottedPlots.length === 0) {
    return { ok: false, reason: "no_rotted_plot", cleared: [] };
  }

  const indexes = rottedPlots.map((p) => p.plotIndex);
  await coll(client).deleteMany({ userId, guildId, plotIndex: { $in: indexes } });

  return {
    ok: true,
    cleared: rottedPlots.map((p) => ({ plotIndex: p.plotIndex, crop: p.crop })),
  };
}

// 施肥：扣材料、套用效果（縮短時間 / 提升收成上限）。
async function fertilize(client, { userId, guildId, plotIndex, fertilizerKey, count = 1 }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const fert = farming.fertilizers?.[fertilizerKey];
  if (!fert) return { ok: false, reason: "invalid_fertilizer" };

  const plot = await coll(client).findOne({ userId, guildId, plotIndex }).catch(() => null);
  if (!plot || plot.status === "empty" || !plot.crop) {
    return { ok: false, reason: "empty_plot" };
  }
  if (plot.status === "rotted") {
    return { ok: false, reason: "already_rotted" };
  }
  if (plot.status === "ready") {
    return { ok: false, reason: "already_ready" };
  }

  // 部分肥料只對特定作物有效
  if (Array.isArray(fert.onlyCrops) && !fert.onlyCrops.includes(plot.crop)) {
    return { ok: false, reason: "fertilizer_not_applicable", crop: plot.crop };
  }

  const totalQty = (fert.qty || 1) * count;
  const profile = await getOrCreate(client, userId, guildId);

  // 檢查材料
  const sourceField = fert.source === "fish_bag" ? "fish_bag" : "backpack";
  const have = (profile[sourceField] || {})[fert.key] || 0;
  if (have < totalQty) {
    return { ok: false, reason: "insufficient_material", need: totalQty, have, source: sourceField, key: fert.key };
  }

  const crop = farming.crops?.[plot.crop];
  const cap = farming.growthReductionCapPct ?? 0.6;
  const maxReduction = Math.floor((crop?.growMs || 0) * cap);
  const yieldCap = farming.yieldBonusCapPct ?? 2;
  const startYield = plot.yield_bonus_pct || 0;

  // 計算縮短時間（按 count 累加，但封頂於剩餘可縮空間）；
  // 收成加成同步封頂於 yieldCap：塞不下整份就停，不施、不扣，避免浪費章魚／月光。
  const perApply = Math.floor((crop?.growMs || 0) * (fert.growReductionPct || 0));
  const perYield = fert.yieldBonusPct || 0;
  let appliedReductionMs = 0;
  let appliedCount = 0;
  let yieldAdd = 0;
  let stopReason = null;
  for (let i = 0; i < count; i++) {
    if (perYield > 0 && startYield + yieldAdd + perYield > yieldCap) {
      stopReason = "yield_cap_reached";
      break;
    }
    const newReduction = (plot.growth_reduction_ms || 0) + appliedReductionMs + perApply;
    if (perApply > 0 && newReduction > maxReduction) {
      // 超過上限，最後一次只補到上限
      const room = maxReduction - (plot.growth_reduction_ms || 0) - appliedReductionMs;
      if (room <= 0) { stopReason = "growth_cap_reached"; break; }
      appliedReductionMs += room;
      appliedCount += 1;
      yieldAdd += perYield;
      break;
    }
    appliedReductionMs += perApply;
    appliedCount += 1;
    yieldAdd += perYield;
  }
  if (appliedCount === 0) {
    return { ok: false, reason: stopReason || "growth_cap_reached", yieldCap, currentYield: startYield };
  }
  const consumed = (fert.qty || 1) * appliedCount;

  // 更新地塊
  const newReadyAt = Math.max(Date.now(), plot.ready_at - appliedReductionMs);
  const newExpiresAt = newReadyAt + (crop?.rotMs || 0);
  const newYieldBonus = Math.min(yieldCap, startYield + yieldAdd);

  await coll(client).updateOne(
    { userId, guildId, plotIndex },
    {
      $set: {
        ready_at: newReadyAt,
        expires_at: newExpiresAt,
        growth_reduction_ms: (plot.growth_reduction_ms || 0) + appliedReductionMs,
        yield_bonus_pct: newYieldBonus,
        updatedAt: new Date(),
      },
      $push: { fertilizers: { $each: Array(appliedCount).fill(fertilizerKey) } },
    },
  );

  // 扣材料
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { [`${sourceField}.${fert.key}`]: -consumed },
      $set: { updatedAt: new Date() },
    },
  );

  return {
    ok: true,
    fert,
    appliedCount,
    consumed,
    newReadyAt,
    newExpiresAt,
    newYieldBonus,
    reductionMs: appliedReductionMs,
  };
}

// 一鍵施肥預覽：算出此肥料能對多少塊成長中地塊各施 1 份、消耗多少材料。
// 不寫庫；只給 UI 顯示用。
async function previewFertilizeAll(client, { userId, guildId, fertilizerKey }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const fert = farming.fertilizers?.[fertilizerKey];
  if (!fert) return { ok: false, reason: "invalid_fertilizer" };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  const plots = await getPlots(client, userId, guildId, plotCount);
  const now = Date.now();
  const cap = farming.growthReductionCapPct ?? 0.6;
  const yieldCap = farming.yieldBonusCapPct ?? 2;

  const skipped = [];
  const eligible = [];
  for (const p of plots) {
    const live = resolveLiveStatus(p, now);
    if (!live.crop) continue;
    if (live.status === "ready") { skipped.push({ plotIndex: live.plotIndex, reason: "already_ready" }); continue; }
    if (live.status === "rotted") { skipped.push({ plotIndex: live.plotIndex, reason: "already_rotted" }); continue; }
    if (live.status === "raided") { skipped.push({ plotIndex: live.plotIndex, reason: "under_raid" }); continue; }
    if (live.status !== "growing") continue;
    if (Array.isArray(fert.onlyCrops) && !fert.onlyCrops.includes(live.crop)) {
      skipped.push({ plotIndex: live.plotIndex, reason: "fertilizer_not_applicable" });
      continue;
    }
    // 純收成肥料（章魚）已達收成上限 → 一份都施不下，先跳過
    if (fert.yieldBonusPct > 0 && !(fert.growReductionPct > 0)
      && (live.yield_bonus_pct || 0) + fert.yieldBonusPct > yieldCap) {
      skipped.push({ plotIndex: live.plotIndex, reason: "yield_cap_reached" });
      continue;
    }
    if (fert.growReductionPct > 0 && !(fert.yieldBonusPct > 0)) {
      const crop = farming.crops?.[live.crop];
      const maxReduction = Math.floor((crop?.growMs || 0) * cap);
      const room = maxReduction - (live.growth_reduction_ms || 0);
      if (room <= 0) {
        skipped.push({ plotIndex: live.plotIndex, reason: "growth_cap_reached" });
        continue;
      }
    }
    eligible.push(live);
  }

  const sourceField = fert.source === "fish_bag" ? "fish_bag" : "backpack";
  const perPlot = fert.qty || 1;
  const have = (profile[sourceField] || {})[fert.key] || 0;
  const maxAffordable = Math.floor(have / perPlot);
  const willApply = Math.min(eligible.length, maxAffordable);
  const willConsume = willApply * perPlot;

  return {
    ok: true,
    fert,
    eligibleCount: eligible.length,
    willApply,
    willConsume,
    have,
    perPlot,
    sourceField,
    skipped,
    materialShort: willApply < eligible.length,
  };
}

// 一鍵施肥：對所有 growing 地塊各施 1 份；材料用完即停。
// excludePlotIndex：用在「對其他成長中地塊也施一份」的快捷按鈕，跳過剛剛已處理的那塊。
// profile / plots / 材料一次讀，逐塊在記憶體結算單份施用，最後批次寫地塊 + 一次扣材料。
async function fertilizeAll(client, { userId, guildId, fertilizerKey, excludePlotIndex = null }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const fert = farming.fertilizers?.[fertilizerKey];
  if (!fert) return { ok: false, reason: "invalid_fertilizer" };

  const profile = await getOrCreate(client, userId, guildId);
  const plotCount = getPlotCount(profile);
  const plots = await getPlots(client, userId, guildId, plotCount);
  const now = Date.now();

  const sourceField = fert.source === "fish_bag" ? "fish_bag" : "backpack";
  const perPlot = fert.qty || 1;
  let materialRemaining = (profile[sourceField] || {})[fert.key] || 0;
  const cap = farming.growthReductionCapPct ?? 0.6;
  const yieldCap = farming.yieldBonusCapPct ?? 2;
  const perYield = fert.yieldBonusPct || 0;

  const applied = [];
  const skipped = [];
  const bulkOps = [];
  let stoppedByMaterial = false;
  let totalConsumed = 0;
  for (const p of plots) {
    const live = resolveLiveStatus(p, now);
    if (!live.crop || live.status !== "growing") continue;
    if (excludePlotIndex != null && live.plotIndex === excludePlotIndex) continue;
    if (Array.isArray(fert.onlyCrops) && !fert.onlyCrops.includes(live.crop)) {
      skipped.push({ plotIndex: live.plotIndex, reason: "fertilizer_not_applicable" });
      continue;
    }
    if (materialRemaining < perPlot) { stoppedByMaterial = true; break; }

    const crop = farming.crops?.[live.crop];
    const maxReduction = Math.floor((crop?.growMs || 0) * cap);
    const perApply = Math.floor((crop?.growMs || 0) * (fert.growReductionPct || 0));
    const startYield = live.yield_bonus_pct || 0;
    const baseReduction = live.growth_reduction_ms || 0;

    // 單份施用：先擋收成上限，再擋成長上限（與 fertilize count=1 等價）
    let appliedReductionMs = 0;
    let reason = null;
    if (perYield > 0 && startYield + perYield > yieldCap) {
      reason = "yield_cap_reached";
    } else if (perApply > 0) {
      const room = maxReduction - baseReduction;
      if (room <= 0) reason = "growth_cap_reached";
      else appliedReductionMs = Math.min(perApply, room);
    }
    if (reason) { skipped.push({ plotIndex: live.plotIndex, reason }); continue; }

    const newReadyAt = Math.max(now, live.ready_at - appliedReductionMs);
    const newExpiresAt = newReadyAt + (crop?.rotMs || 0);
    const newYieldBonus = Math.min(yieldCap, startYield + perYield);
    bulkOps.push({
      updateOne: {
        filter: { userId, guildId, plotIndex: live.plotIndex },
        update: {
          $set: {
            ready_at: newReadyAt,
            expires_at: newExpiresAt,
            growth_reduction_ms: baseReduction + appliedReductionMs,
            yield_bonus_pct: newYieldBonus,
            updatedAt: new Date(),
          },
          $push: { fertilizers: fertilizerKey },
        },
      },
    });
    materialRemaining -= perPlot;
    totalConsumed += perPlot;
    applied.push({
      plotIndex: live.plotIndex,
      fert,
      appliedCount: 1,
      consumed: perPlot,
      newReadyAt,
      newExpiresAt,
      newYieldBonus,
      reductionMs: appliedReductionMs,
    });
  }

  if (applied.length === 0) {
    return { ok: false, reason: "no_eligible_plot", fert, applied, skipped, stoppedByMaterial };
  }

  await coll(client).bulkWrite(bulkOps, { ordered: false });
  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: { [`${sourceField}.${fert.key}`]: -totalConsumed },
      $set: { updatedAt: new Date() },
    },
  );

  return {
    ok: true,
    reason: null,
    fert,
    applied,
    skipped,
    stoppedByMaterial,
  };
}

// 擴建預覽：只回傳下一階資訊與目前金幣，不執行扣費。
async function previewExpand(client, { userId, guildId }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const current = getPlotCount(profile);
  const tiers = farming.plotTiers || [];
  const nextTier = tiers.find((t) => t.count > current);
  if (!nextTier) {
    return { ok: false, reason: "max_reached", current };
  }

  const coinDoc = await client.userCoinsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  const have = coinDoc?.totalCoins || 0;

  return {
    ok: true,
    current,
    nextCount: nextTier.count,
    cost: nextTier.cost,
    have,
    canAfford: have >= nextTier.cost,
  };
}

// 擴建：依下一個 plotTier 扣幣、提升 farm_plot_count。
async function expandFarm(client, { userId, guildId, username, member }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const current = getPlotCount(profile);
  const tiers = farming.plotTiers || [];
  const nextTier = tiers.find((t) => t.count > current);
  if (!nextTier) {
    return { ok: false, reason: "max_reached", current };
  }

  const coinDoc = await client.userCoinsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  const have = coinDoc?.totalCoins || 0;
  if (have < nextTier.cost) {
    return { ok: false, reason: "insufficient_coins", need: nextTier.cost, have, nextCount: nextTier.count };
  }

  await grantCoins(client, {
    userId, guildId, username, member,
    amount: -nextTier.cost,
    source: "farm_expand",
    meta: { from: current, to: nextTier.count },
  });

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $set: { farm_plot_count: nextTier.count, updatedAt: new Date() } },
  );

  return { ok: true, from: current, to: nextTier.count, cost: nextTier.cost };
}

// Raid 兌現判定：地塊是否「已排定 raid_at 且到時間」→ 該翻成入侵。
// raid_at 於種植時一次決定（見 rollRaidAt），這裡不再擲骰，所以看幾次都不影響命運、
// 也無法用 /收成 繞過（收成路徑同樣先走 applyPendingRaids）。
// 已枯萎的作物不再被攻擊（以即時推算為準，不依賴 cron 對齊）。
function shouldTriggerRaid(plot, now = Date.now()) {
  if (!plot || plot.status === "empty" || !plot.crop) return false;
  if (plot.raid?.active) return true;
  if (!plot.raid_at || now < plot.raid_at) return false;
  const live = resolveLiveStatus(plot, now);
  return live.status === "growing" || live.status === "ready";
}

// 共用兌現：把所有「已到 raid_at」的地塊翻成入侵（陷阱優先抵擋）。view / 收成 /
// 施肥 各路徑都走這支，確保觸發一致、無法繞過。直接 mutate 傳入的 plots，
// 回傳陷阱使用摘要與本次真正被入侵的地塊，供 UI 顯示與主動通知使用。
//
// 陷阱分兩階：簡易（鐵礦，70%）與高級（碎片，100%）。由弱到強消耗，
// 把必定成功的留到後面；簡易陷阱擲骰失敗時仍會被消耗，該地塊照樣被入侵。
async function applyPendingRaids(client, { userId, guildId, plots, profile, now = Date.now() }) {
  const remaining = {};
  for (const t of trapTiers.tiers()) remaining[t.field] = profile?.[t.field] || 0;
  const usedByField = {};
  let trapBlocksUsedThisOpen = 0;
  let trapFailures = 0;
  const raided = [];

  // 取出一次抵擋機會：由弱到強，回傳是否真的擋下來
  const consumeTrap = () => {
    for (const t of trapTiers.tiers()) {
      if (remaining[t.field] <= 0) continue;
      remaining[t.field] -= 1;
      usedByField[t.field] = (usedByField[t.field] || 0) + 1;
      trapBlocksUsedThisOpen += 1;
      const blocked = Math.random() < (t.blockChance ?? 1);
      if (!blocked) trapFailures += 1;
      return blocked;
    }
    return false;
  };

  for (const p of plots) {
    if (p.raid?.active) continue;
    if (!shouldTriggerRaid(p, now)) continue;
    if (consumeTrap()) {
      await coll(client).updateOne(
        { userId, guildId, plotIndex: p.plotIndex },
        { $set: { raid_at: null, updatedAt: new Date() } },
      );
      p.raid_at = null;
      continue;
    }
    const live = resolveLiveStatus(p, now);
    const raid = await markRaid(client, {
      userId, guildId, plotIndex: p.plotIndex, fromStatus: live.status,
    });
    if (raid) {
      p.status = "raided";
      p.raid = raid;
      p.raid_at = null;
      raided.push(p);
    }
  }
  if (trapBlocksUsedThisOpen > 0) {
    const inc = {};
    for (const [field, n] of Object.entries(usedByField)) inc[field] = -n;
    await client.miningProfilesCollection.updateOne(
      { userId, guildId },
      { $inc: inc, $set: { updatedAt: new Date() } },
    );
  }
  return {
    trapBlocksRemaining: Object.values(remaining).reduce((a, b) => a + b, 0),
    trapBlocksUsedThisOpen,
    trapBlocksBlocked: trapBlocksUsedThisOpen - trapFailures,
    trapFailures,
    // remaining 是「這次消耗完之後」的狀態；傳入的 profile 沒被 mutate，
    // 呼叫端拿 profile 去算會顯示舊數字。
    trapHoldings: trapTiers.describeHoldings(remaining),
    raided,
  };
}

// 標記地塊進入 raid 狀態。回傳怪物資訊。
// 紀錄 pre_status，讓防禦成功後能恢復到原本是 growing 還是 ready。
async function markRaid(client, { userId, guildId, plotIndex, fromStatus }) {
  const raidCfg = farming?.raid;
  if (!raidCfg) return null;
  const list = raidCfg.monsters || [];
  if (!list.length) return null;
  const monster = list[Math.floor(Math.random() * list.length)];
  const raid = {
    active: true,
    monsterName: monster.name,
    monsterEmoji: monster.emoji,
    monsterHp: monster.hp,
    expires_at: Date.now() + 30 * 60 * 1000,
    pre_status: fromStatus === "growing" ? "growing" : "ready",
  };
  await coll(client).updateOne(
    { userId, guildId, plotIndex },
    { $set: { status: "raided", raid, raid_at: null, updatedAt: new Date() } },
  );
  return raid;
}

// 防禦：耗 1 體力 + 武器耐久，依玩家 ATK 與怪物 HP 計算勝率；勝→獎金、敗→毀作物。
async function defendRaid(client, { userId, guildId, username, member, plotIndex }) {
  const dungeonService = require("../mining/dungeonService");
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const plot = await coll(client).findOne({ userId, guildId, plotIndex }).catch(() => null);
  if (!plot || plot.status !== "raided" || !plot.raid?.active) {
    return { ok: false, reason: "no_raid" };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const club = await dungeonService.getMemberClub(client, userId, guildId);
  const max = dungeonService.staminaMax(member, club);
  const st = dungeonService.resolveStamina(profile, max);
  if (st.stamina <= 0) {
    return { ok: false, reason: "no_stamina", nextRegenAt: st.nextRegenAt };
  }
  if (!dungeonService.hasWeapon(profile)) {
    return { ok: false, reason: "no_weapon" };
  }

  const now = Date.now();
  const atk = dungeonService.playerAtk(profile);
  const monsterHp = plot.raid.monsterHp || 100;
  const winRate = Math.max(0.2, Math.min(0.9, atk / monsterHp));
  const won = Math.random() < winRate;

  // 扣體力
  const newStamina = st.stamina - 1;
  const wasFull = st.stamina >= max;
  const newStamUpdatedAt = wasFull ? now : st.updatedAt;

  // 扣武器耐久
  const set = {
    stamina: newStamina,
    stamina_updated_at: newStamUpdatedAt,
    updatedAt: new Date(),
  };
  const inc = {};
  const weaponBefore = profile.weapon;
  let weaponBroke = false;
  let weaponDurabilityAfter = null;
  if (profile.weapon !== "fist" && typeof profile.weapon_durability === "number") {
    weaponDurabilityAfter = profile.weapon_durability - 1;
    if (weaponDurabilityAfter <= 0) {
      weaponBroke = true;
      weaponDurabilityAfter = null;
      set.weapon = "fist";
      set.weapon_durability = null;
      set.weapon_max_durability = null;
    } else {
      inc.weapon_durability = -1;
    }
  }

  let coinsGained = 0;
  let slimeGained = 0;
  let droppedTrapFragment = false;
  if (won) {
    const [cLo, cHi] = farming.raid?.winRewards?.coins || [0, 0];
    coinsGained = randInt(cLo, cHi);
    const [sLo, sHi] = farming.raid?.winRewards?.slime || [0, 0];
    slimeGained = randInt(sLo, sHi);
    if (slimeGained > 0) inc["backpack.monster_slime"] = slimeGained;
    const fragChance = farming.raid?.winRewards?.brokenTrapFragmentChance || 0;
    if (fragChance > 0 && Math.random() < fragChance) {
      droppedTrapFragment = true;
      inc.broken_trap_fragments = 1;
    }
  } else {
    // 戰敗安慰：作物照樣毀，但撿回一點殘局（金幣＋少量黏液），降低「全損」的痛感。
    const [cLo, cHi] = farming.raid?.loseRewards?.coins || [0, 0];
    coinsGained = randInt(cLo, cHi);
    const [sLo, sHi] = farming.raid?.loseRewards?.slime || [0, 0];
    slimeGained = randInt(sLo, sHi);
    if (slimeGained > 0) inc["backpack.monster_slime"] = slimeGained;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    Object.keys(inc).length ? { $inc: inc, $set: set } : { $set: set },
  );

  if (coinsGained > 0) {
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: coinsGained,
      source: "farm_raid",
      meta: { plotIndex, monster: plot.raid.monsterName },
    });
  }

  if (won) {
    // 恢復到 raid 前的狀態（growing 繼續長、ready 可立即收成）
    const restoreStatus = plot.raid?.pre_status === "growing" ? "growing" : "ready";
    await coll(client).updateOne(
      { userId, guildId, plotIndex },
      { $set: { status: restoreStatus, raid: null, updatedAt: new Date() } },
    );
  } else {
    // 作物被毀
    await coll(client).deleteOne({ userId, guildId, plotIndex });
  }

  const legendarySwordBroke =
    weaponBroke && swordBreakService.isTrackedSword(weaponBefore);
  // 傳說級以上的劍不論在哪斷都要計入斷劍榜（fire-and-forget，自帶錯誤吞掉）
  if (legendarySwordBroke) {
    swordBreakService
      .handleLegendaryBreak(client, { userId, guildId, weapon: weaponBefore, where: "農地防禦戰" })
      .catch(() => {});
  }

  return {
    ok: true,
    won,
    atk,
    monster: plot.raid,
    coinsGained,
    slimeGained,
    droppedTrapFragment,
    weaponBefore,
    weaponBroke,
    weaponDurabilityAfter,
    legendarySwordBroke,
    stamina: newStamina,
    staminaMax: max,
  };
}

// 零體力備案：擺個陷阱賭機率。不消耗體力 / 武器，成功率低、獎勵小，
// 失敗一樣毀作物。設計目的：玩家在體力被地下城耗光時還有事可做，
// 不用乾等。每場 raid 自然一次性（成功 raid 結束、失敗作物消失）。
async function setTrap(client, { userId, guildId, username, member, plotIndex }) {
  if (!farming?.enabled) return { ok: false, reason: "disabled" };
  if (!coll(client)) return { ok: false, reason: "disabled" };

  const plot = await coll(client).findOne({ userId, guildId, plotIndex }).catch(() => null);
  if (!plot || plot.status !== "raided" || !plot.raid?.active) {
    return { ok: false, reason: "no_raid" };
  }

  const trapCfg = farming.raid?.trap || {};
  const successRate = trapCfg.successRate ?? 0.3;
  const won = Math.random() < successRate;

  let coinsGained = 0;
  let flavor = null;
  if (won) {
    const [cLo, cHi] = trapCfg.winCoins || [0, 0];
    coinsGained = randInt(cLo, cHi);
  } else {
    const [cLo, cHi] = trapCfg.loseCoins || [0, 0];
    coinsGained = randInt(cLo, cHi);
    const flavors = trapCfg.failFlavors || [];
    if (flavors.length) flavor = flavors[Math.floor(Math.random() * flavors.length)];
  }

  if (coinsGained > 0) {
    await grantCoins(client, {
      userId, guildId, username, member,
      amount: coinsGained,
      source: "farm_raid_trap",
      meta: { plotIndex, monster: plot.raid.monsterName },
    });
  }

  if (won) {
    const restoreStatus = plot.raid?.pre_status === "growing" ? "growing" : "ready";
    await coll(client).updateOne(
      { userId, guildId, plotIndex },
      { $set: { status: restoreStatus, raid: null, updatedAt: new Date() } },
    );
  } else {
    await coll(client).deleteOne({ userId, guildId, plotIndex });
  }

  return {
    ok: true,
    won,
    monster: plot.raid,
    coinsGained,
    flavor,
    successRate,
  };
}

// 取「下一個將成熟」的地塊 ready_at（仍在 growing 且尚未到期），用於把農場到點
// 通知對齊到真正要 DM 的時間。施肥剛把 ready_at 夾到 now、或被追蹤的那塊已成熟時，
// 跳過它去找下一塊還在長的，避免單塊覆蓋掉整個玩家的提醒。沒有時回 0。
async function getNextReadyAt(client, userId, guildId) {
  const c = coll(client);
  if (!c) return 0;
  const plot = await c
    .findOne(
      { userId, guildId, status: "growing", ready_at: { $gt: Date.now() } },
      { sort: { ready_at: 1 }, projection: { ready_at: 1 } },
    )
    .catch(() => null);
  return plot?.ready_at || 0;
}

// Cron 用：掃 growing→ready、ready→rotted。回傳更新數量供日誌使用。
async function runDecaySweep(client) {
  const c = coll(client);
  if (!c) return { ready: 0, rotted: 0 };
  const now = Date.now();

  // growing → ready（不含 raided）
  const readyResult = await c.updateMany(
    { status: "growing", ready_at: { $lte: now } },
    { $set: { status: "ready", updatedAt: new Date() } },
  ).catch(() => ({ modifiedCount: 0 }));

  // ready → rotted（已過 expires_at 又沒被收成）
  const rottedResult = await c.updateMany(
    { status: { $in: ["ready", "growing"] }, expires_at: { $lte: now } },
    { $set: { status: "rotted", raid: null, updatedAt: new Date() } },
  ).catch(() => ({ modifiedCount: 0 }));

  return { ready: readyResult.modifiedCount || 0, rotted: rottedResult.modifiedCount || 0 };
}

module.exports = {
  plantCrop,
  plantAllCrops,
  harvestCrop,
  harvestAllCrops,
  clearRottedCrops,
  fertilize,
  fertilizeAll,
  previewFertilizeAll,
  previewExpand,
  expandFarm,
  defendRaid,
  setTrap,
  shouldTriggerRaid,
  applyPendingRaids,
  markRaid,
  runDecaySweep,
  getPlots,
  getPlotCount,
  resolveLiveStatus,
  getNextReadyAt,
};
