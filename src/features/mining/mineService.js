require("colors");
const { DateTime } = require("luxon");
const { mining, craft } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed, ORE_KEYS } = require("./miningProfile");
const dropTable = require("./dropTable");
const unifiedBuffResolver = require("../buff/buffResolver");
const encounterService = require("./encounterService");
const { consumeMineLuckUse, formatFoodBuffLines } = require("../fishing/cookService");
const grantCoins = require("../economy/grantCoins");
const grantActivityXp = require("../leveling/grantActivityXp");
const { priceOf } = require("./overflowConfirm");
const buildingService = require("../guild_club/buildingService");
const bus = require("../eventBus");

// 連續挖礦通行證：付費啟用後 1 小時內無視 Lv.100 解鎖門檻（存 expires_at，用時即時判定）。
function isBatchPassActive(profile) {
  return (profile?.batch_pass_expires_at || 0) > Date.now();
}

// 啟用一張連續挖礦通行證：扣一張、寫入 expires_at。已在生效中則不重複啟用（避免浪費）。
async function activateMiningPass(client, { userId, guildId }) {
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();
  if ((profile.batch_pass_expires_at || 0) > now) {
    return { ok: false, reason: "already_active", expiresAt: profile.batch_pass_expires_at };
  }
  if ((profile.mining_pass_count || 0) < 1) {
    return { ok: false, reason: "no_pass" };
  }
  const durationMs = mining?.batch?.passDurationMs || 3600000;
  const expiresAt = now + durationMs;
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      mining_pass_count: { $gte: 1 },
      $or: [{ batch_pass_expires_at: { $lte: now } }, { batch_pass_expires_at: { $exists: false } }],
    },
    { $inc: { mining_pass_count: -1 }, $set: { batch_pass_expires_at: expiresAt, updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };
  const after = await client.miningProfilesCollection
    .findOne({ userId, guildId }, { projection: { mining_pass_count: 1 } })
    .catch(() => null);
  return { ok: true, expiresAt, passesLeft: after?.mining_pass_count || 0 };
}

// 執行一次挖礦。回傳結果物件交由指令層呈現（含彩虹石公告與耐久 DM 所需資料）。
// allowOverflow=true：背包滿時不擋；roll 出的礦能放多少放多少，溢出折成系統收購價金幣。
// batchCtx（連續挖礦專用，單次挖礦不傳）：
//   { gc }        — 整批共用、預先算好的公會 buff，避免每輪重查公會
//   { logSink }   — 收集本輪 mineLog，由批次結束後一次 insertMany
//   { deferXp }   — 不逐輪授予經驗，只 roll 出基礎值放進 result.xpBase，由批次匯總後一次授予
async function mine(client, { userId, guildId, member, username, allowOverflow = false, batchCtx = null }) {
  if (!mining?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  if ((profile.mine_cooldown_at || 0) > now) {
    const today = DateTime.now().setZone("Asia/Taipei").toISODate();
    const dailyLimit = mining?.cdTicketDailyUseLimit || 0;
    const usedToday =
      profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;
    const cdCap = backpackCapacity(profile, mining);
    const cdUsed = backpackUsed(profile);
    return {
      ok: false,
      reason: "cooldown",
      remainingMs: profile.mine_cooldown_at - now,
      readyAt: profile.mine_cooldown_at,
      cdTickets: profile.cd_ticket_count || 0,
      cdTicketUsedToday: usedToday,
      cdTicketDailyLimit: dailyLimit,
      cdTicketReductionMs: mining?.cdTicketReductionMs || 0,
      pickaxe: profile.pickaxe,
      pickaxeDurability: profile.pickaxe_durability,
      pickaxeMaxDurability: profile.pickaxe_max_durability,
      backpackCap: cdCap,
      backpackUsed: cdUsed,
      backpackFree: Math.max(0, cdCap - cdUsed),
    };
  }

  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap && !allowOverflow) {
    return { ok: false, reason: "backpack_full", used, cap };
  }

  const buff = await unifiedBuffResolver.getMiningResolve(
    client,
    userId,
    guildId,
    member,
    { profile, gc: batchCtx?.gc }
  );
  const ore = dropTable.roll(buff.luckBonus);
  let qty = dropTable.randQty(ore, buff.qtyBonus);

  // 背包空間配置：能塞多少塞多少，溢出依模式決定（folder/丟棄）
  const space = Math.max(0, cap - used);
  let overflowQty = 0;
  if (qty > space) {
    if (allowOverflow) {
      overflowQty = qty - space;
      qty = space;
    } else {
      qty = space;
    }
  }
  const overflowCoins = overflowQty > 0 ? priceOf(ore) * overflowQty : 0;

  const newCooldownAt = now + buff.actualCdMs;

  const inc = {
    mine_count_total: 1,
  };
  if (qty > 0) {
    inc[`backpack.${ore}`] = qty;
    inc[`lifetime_ore.${ore}`] = qty;
  }
  if (buff.consume.usePotion) inc.luck_potion_uses = -1;

  const set = { mine_cooldown_at: newCooldownAt, updatedAt: new Date() };

  // 賭石（鑑定師）：只有「剛挖到石頭那一次」能賭。每次挖礦都覆寫 pending_appraisal——
  // 挖到石頭就記下本次數量與時間戳，挖到別的礦則清為 null，確保只認最新一次挖礦。
  const sa = mining?.stoneAppraisal;
  const appraisalEligible = !!(sa?.enabled && ore === "stone" && qty > 0);
  set.pending_appraisal = appraisalEligible ? { qty, ts: now } : null;

  // 耐久：非木鎬且有耐久值才消耗；歸 0 退回木鎬
  let durabilityBroke = false;
  let durabilityAfter = null;
  let durabilityWarnCrossed = null;
  const hasDurability =
    profile.pickaxe !== "wood" && typeof profile.pickaxe_durability === "number";
  if (hasDurability) {
    const before = profile.pickaxe_durability;
    durabilityAfter = before - 1;
    if (durabilityAfter <= 0) {
      durabilityBroke = true;
      durabilityAfter = null;
      set.pickaxe = "wood";
      set.pickaxe_durability = null;
      set.pickaxe_max_durability = null;
    } else {
      inc.pickaxe_durability = -1;
      const warn = mining?.durabilityWarn || {};
      if (typeof warn.critical === "number" && before > warn.critical && durabilityAfter <= warn.critical) {
        durabilityWarnCrossed = "critical";
      } else if (typeof warn.low === "number" && before > warn.low && durabilityAfter <= warn.low) {
        durabilityWarnCrossed = "low";
      }
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set }
  );

  if (overflowCoins > 0) {
    await grantCoins(client, {
      userId, guildId, username,
      amount: overflowCoins,
      source: "mine_overflow",
      member,
      meta: { ore, overflowQty, deliveredQty: qty },
    }).catch((e) => console.log(`[ERROR] mine overflow grantCoins: ${e}`.red));
  }

  if (client.mineLogsCollection) {
    const logDoc = { user_id: userId, guild_id: guildId, ore, qty: qty + overflowQty, ts: new Date() };
    // 連續挖礦：交由批次結束後一次 insertMany；單次挖礦：fire-and-forget，不阻塞回覆。
    if (batchCtx?.logSink) {
      batchCtx.logSink.push(logDoc);
    } else {
      client.mineLogsCollection
        .insertOne(logDoc)
        .catch((e) => console.log(`[ERROR] insert mine log: ${e}`.red));
    }
  }

  // 食物 buff：若 mine_luck uses 型 buff 生效，異步消耗一次使用次數
  if (buff.foodLuckBonus > 0) {
    consumeMineLuckUse(client, userId, guildId, profile).catch(() => {});
  }

  const backpackUsedAfter = used + (ORE_KEYS.includes(ore) ? qty : 0);

  // 連續挖礦：只 roll 出基礎經驗，批次匯總後一次授予；單次挖礦：照常即時授予。
  let xpGained = 0;
  let xpBase = 0;
  if (batchCtx?.deferXp) {
    xpBase = grantActivityXp.roll("mine");
  } else {
    xpGained = await grantActivityXp(client, "mine", {
      userId,
      guildId,
      username,
      member,
      meta: { ore },
    });
  }

  const result = {
    ok: true,
    ore,
    qty,
    xpGained,
    xpBase,
    overflowQty,
    overflowCoins,
    buff,
    foodBuffLines: formatFoodBuffLines(profile, "mine"),
    newCooldownAt,
    pickaxeBefore: profile.pickaxe,
    durabilityBroke,
    durabilityAfter,
    durabilityWarnCrossed,
    mineCountTotal: (profile.mine_count_total || 0) + 1,
    backpackCap: cap,
    backpackUsed: backpackUsedAfter,
    backpackFree: Math.max(0, cap - backpackUsedAfter),
  };

  // 提供指令層組「找鑑定師賭石」按鈕所需資訊（ts 要與寫入 DB 的 pending_appraisal 一致）
  if (appraisalEligible) {
    result.appraisal = { qty, ts: now, feePerStone: sa.feePerStone || 0 };
  }

  // 突發事件（戰鬥擴充）：採集後以一定機率觸發。會自行寫庫，可能翻倍 / 損失本次掉落、
  // 清除冷卻、或觸發怪物突襲（用玩家武器自動結算）。
  const enc = await encounterService
    .trigger(client, {
      context: "mining",
      userId,
      guildId,
      member,
      username,
      baseResult: result,
    })
    .catch(() => null);
  if (enc) {
    if (typeof enc.patch?.newCooldownAt === "number") {
      result.newCooldownAt = enc.patch.newCooldownAt;
    }
    result.encounter = { name: enc.name, emoji: enc.emoji, body: enc.body };
    if (enc.diamondGained > 0) result.encounterDiamond = enc.diamondGained;
  }

  // 世界事件觸發 roll：fire-and-forget，不阻塞主流程
  require("../world_event/worldEventService")
    .rollTrigger(client, "mining_drop", { ore })
    .catch(() => {});

  bus.emit("mine.done", {
    userId,
    guildId,
    ore,
    qty,
    mineCountTotal: result.mineCountTotal,
  });
  if (qty > 0) {
    bus.emit("item.gained", {
      userId,
      guildId,
      itemType: "ore",
      itemId: ore,
      qty,
      source: "mine",
    });
  }

  // 賭石只能賭「這次挖到還留著的石頭」。突發事件可能扣掉本次剛挖到的石頭（lose_ore），
  // 用挖礦前後背包石頭數差回推還剩幾顆屬於這次挖到的，同步修正 pending 與按鈕顯示，
  // 避免按鈕標 2 顆但實際只能賭 1 顆、或舊存量被誤算進賭石範圍。
  // 連續挖礦：pending 由批次結束時依整批石頭數重算並覆寫，這裡的逐輪修正是白工，直接跳過。
  if (appraisalEligible && !batchCtx) {
    const after = await client.miningProfilesCollection.findOne(
      { userId, guildId },
      { projection: { "backpack.stone": 1 } }
    );
    const stoneBefore = profile.backpack?.stone || 0;
    const stoneAfter = after?.backpack?.stone || 0;
    const effectiveQty = Math.max(0, Math.min(qty, stoneAfter - stoneBefore));
    if (effectiveQty !== qty) {
      if (effectiveQty > 0) {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId, "pending_appraisal.ts": now },
          { $set: { "pending_appraisal.qty": effectiveQty, updatedAt: new Date() } }
        );
        result.appraisal.qty = effectiveQty;
      } else {
        await client.miningProfilesCollection.updateOne(
          { userId, guildId, "pending_appraisal.ts": now },
          { $set: { pending_appraisal: null, updatedAt: new Date() } }
        );
        delete result.appraisal;
      }
    }
  }

  return result;
}

// 從玩家持有的維修工具中挑一把「最划算」的：優先 max 不降（甚至 +）、其次補得多。
// 回傳 { tier, name, emoji, count } 或 null（沒有維修工具）。
function bestRepairTool(repairToolsOwned) {
  const tools = craft?.repairTools || {};
  const owned = Object.entries(tools)
    .map(([tier, def]) => ({
      tier,
      name: def.name,
      emoji: def.emoji,
      count: (repairToolsOwned || {})[tier] || 0,
    }))
    .filter((o) => o.count > 0);
  if (!owned.length) return null;
  owned.sort(
    (a, b) =>
      (tools[b.tier].maxDelta || 0) - (tools[a.tier].maxDelta || 0) ||
      (tools[b.tier].duraPct || 0) - (tools[a.tier].duraPct || 0),
  );
  return owned[0];
}

// 連續挖礦（批次）：一次挖 count 次，省去逐次點按。
// 資源模型：第一次免費（照常需已過冷卻），之後每次消耗 1 張 CD 縮短券。
// 實作採「重用單次 mine()」：每次迭代前清掉上一次設下的冷卻並扣一張券，
// 讓 mine() 通過自身冷卻檢查。所有加成、突發事件、耐久、掉落都沿用單次邏輯，不另寫死。
// 工具（鎬子）中途壞掉 → 立即停止、不再扣券（未用到的券自然保留）。
// 石頭統一在最後匯總成一筆 pending_appraisal，讓玩家一次決定要賭幾顆。
async function mineBatch(client, { userId, guildId, member, username, count, onProgress }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const bcfg = mining?.batch || {};
  if (!bcfg.enabled) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  const unlockLevel = bcfg.unlockLevel || 0;
  if (unlockLevel > 0 && !isBatchPassActive(profile)) {
    const userLevel = await client.userLevelsCollection
      ?.findOne({ userId, guildId })
      .catch(() => null);
    const lvl = userLevel?.level ?? 0;
    if (lvl < unlockLevel) {
      return {
        ok: false,
        reason: "level_locked",
        required: unlockLevel,
        current: lvl,
        passCount: profile.mining_pass_count || 0,
      };
    }
  }

  // CD 縮短券照常規：一張少 cdTicketReductionMs（預設 30 分）。連續挖礦時，每次挖礦前
  // 若還在冷卻中，就依「剩餘冷卻 ÷ 每張券縮短量」無條件進位算出要花幾張券把冷卻清掉再挖。
  // 例：冷卻 1 小時 → 2 張券；2 小時 → 4 張券。已可挖（無冷卻）則免券直接挖。
  const reductionMs = mining?.cdTicketReductionMs || 1800000;
  const maxCount = Math.max(1, bcfg.maxCount || 1);
  const requested = Math.min(Math.max(1, Math.floor(count || 1)), maxCount);
  const initiallyOnCooldown = (profile.mine_cooldown_at || 0) > now;

  const agg = {
    ok: true,
    requested,
    maxCount,
    performed: 0,
    ticketsSpent: 0,
    stoppedNoTicket: false,
    lastCdMs: 0,
    ores: {},
    overflowOres: {},
    overflowCoins: 0,
    stonesMined: 0,
    diamondQty: 0,
    diamondActions: 0,
    rareActions: 0,
    oreActionCounts: {},
    encounterDiamond: 0,
    encounters: [],
    durabilityBroke: false,
    pickaxeBrokeFrom: null,
    stoppedLowDurability: false,
    lowDurabilityPickaxe: null,
    repairTool: null,
    stoppedEarly: false,
    newCooldownAt: now,
    mineCountTotal: profile.mine_count_total || 0,
    xpGained: 0,
  };
  const RARE = new Set(["iron", "gold", "diamond"]);

  // 整批共用：公會 buff（整批期間玩家公會狀態穩定）預先算一次，逐輪傳入避免重查；
  // mineLog 收集後一次 insertMany；經驗只 roll 不授予，最後匯總一次授予。
  const gc = await unifiedBuffResolver
    .getGuildClubBuffs(client, userId, guildId)
    .catch(() => null);
  const logSink = [];
  let xpBaseSum = 0;
  const batchCtx = { gc, logSink, deferXp: true };

  for (let i = 0; i < requested; i++) {
    // 讀當前冷卻、券數、鎬子耐久與維修工具庫存
    const cur = await client.miningProfilesCollection.findOne(
      { userId, guildId },
      {
        projection: {
          mine_cooldown_at: 1,
          cd_ticket_count: 1,
          pickaxe: 1,
          pickaxe_durability: 1,
          repair_tools: 1,
        },
      },
    );

    // 保護性中止：若這把鎬子再挖一次就會斷（耐久 ≤ 1），在斷掉前先停、不做這一次，
    // 讓鎬子留在耐久 1、不退回木鎬。玩家自己決定要修還是手動挖最後一下。
    if (
      cur?.pickaxe &&
      cur.pickaxe !== "wood" &&
      typeof cur.pickaxe_durability === "number" &&
      cur.pickaxe_durability <= 1
    ) {
      agg.stoppedLowDurability = true;
      agg.lowDurabilityPickaxe = cur.pickaxe;
      agg.repairTool = bestRepairTool(cur.repair_tools);
      agg.stoppedEarly = true;
      break;
    }

    const remaining = (cur?.mine_cooldown_at || 0) - Date.now();
    let spentThisIter = 0;
    if (remaining > 0) {
      const need = Math.ceil(remaining / reductionMs);
      if ((cur?.cd_ticket_count || 0) < need) {
        agg.stoppedNoTicket = true;
        break;
      }
      const res = await client.miningProfilesCollection.updateOne(
        { userId, guildId, cd_ticket_count: { $gte: need } },
        { $inc: { cd_ticket_count: -need }, $set: { mine_cooldown_at: 0, updatedAt: new Date() } },
      );
      if (res.modifiedCount === 0) {
        agg.stoppedNoTicket = true;
        break;
      }
      spentThisIter = need;
      agg.ticketsSpent += need;
    }

    const r = await mine(client, { userId, guildId, member, username, allowOverflow: true, batchCtx });
    if (!r.ok) {
      // 這次沒挖成：把剛扣的券退回
      if (spentThisIter > 0) {
        await client.miningProfilesCollection
          .updateOne({ userId, guildId }, { $inc: { cd_ticket_count: spentThisIter } })
          .catch(() => {});
        agg.ticketsSpent -= spentThisIter;
      }
      break;
    }

    agg.performed++;
    xpBaseSum += r.xpBase || 0;
    if (r.buff?.actualCdMs) agg.lastCdMs = r.buff.actualCdMs;
    agg.newCooldownAt = r.newCooldownAt;
    agg.mineCountTotal = r.mineCountTotal;
    agg.backpackCap = r.backpackCap;
    agg.backpackUsed = r.backpackUsed;
    agg.backpackFree = r.backpackFree;
    agg.pickaxe = r.pickaxeBefore;
    agg.durabilityAfter = r.durabilityAfter;

    if (r.qty > 0) {
      agg.ores[r.ore] = (agg.ores[r.ore] || 0) + r.qty;
      if (r.ore === "stone") agg.stonesMined += r.qty;
      if (r.ore === "diamond") agg.diamondQty += r.qty;
    }
    if (r.overflowQty > 0) {
      agg.overflowOres[r.ore] = (agg.overflowOres[r.ore] || 0) + r.overflowQty;
      agg.overflowCoins += r.overflowCoins || 0;
    }
    agg.oreActionCounts[r.ore] = (agg.oreActionCounts[r.ore] || 0) + 1;
    if (RARE.has(r.ore)) agg.rareActions++;
    if (r.ore === "diamond") agg.diamondActions++;
    if (r.encounterDiamond > 0) agg.encounterDiamond += r.encounterDiamond;
    if (r.encounter) agg.encounters.push(r.encounter);

    if (onProgress) {
      await onProgress({
        performed: agg.performed,
        requested,
        ticketsSpent: agg.ticketsSpent,
        ores: agg.ores,
        step: { n: agg.performed, ore: r.ore, qty: r.qty, overflow: r.overflowQty || 0 },
      }).catch(() => {});
    }

    if (r.durabilityBroke) {
      agg.durabilityBroke = true;
      agg.pickaxeBrokeFrom = r.pickaxeBefore;
      agg.stoppedEarly = true;
      break;
    }
  }

  // 本批 mineLog 一次寫入（fire-and-forget，不阻塞結算）
  if (client.mineLogsCollection && logSink.length > 0) {
    client.mineLogsCollection
      .insertMany(logSink, { ordered: false })
      .catch((e) => console.log(`[ERROR] insert mine logs (batch): ${e}`.red));
  }

  // 整批經驗一次授予：等同逐次授予的總量，但只打一次 UserLevels，升級 / 金幣獎勵照常結算。
  if (xpBaseSum > 0) {
    agg.xpGained = await grantActivityXp(client, "mine", {
      userId,
      guildId,
      username,
      member,
      amount: xpBaseSum,
      meta: { batch: true, count: agg.performed },
    });
  }

  // 石頭匯總成單一 pending_appraisal（覆寫單次 mine() 留下的最後一筆），
  // 讓玩家在結算後一次決定要賭幾顆。上限吃 stoneAppraisal.maxBatch。
  if (agg.stonesMined > 0) {
    const sa = mining?.stoneAppraisal || {};
    // 連續挖礦可賭「這批挖到的所有石頭」，用獨立上限（不受碎石合成的 maxBatch 50 夾住）
    const apprCap = sa.batchMaxStones || sa.maxBatch || 0;
    const eligible = apprCap > 0 ? Math.min(agg.stonesMined, apprCap) : agg.stonesMined;
    if (sa.enabled && eligible > 0) {
      const ts = now;
      await client.miningProfilesCollection.updateOne(
        { userId, guildId },
        { $set: { pending_appraisal: { qty: eligible, ts, synthetic: false }, updatedAt: new Date() } },
      );
      agg.appraisal = { qty: eligible, ts, feePerStone: sa.feePerStone || 0 };
    }
  } else {
    // 這批沒挖到石頭：清掉單次 mine() 可能留下的過期 pending，避免殘留按鈕
    await client.miningProfilesCollection
      .updateOne({ userId, guildId }, { $set: { pending_appraisal: null, updatedAt: new Date() } })
      .catch(() => {});
  }

  if (agg.performed === 0) {
    if (agg.stoppedLowDurability) {
      return {
        ok: false,
        reason: "low_durability",
        pickaxe: agg.lowDurabilityPickaxe,
        repairTool: agg.repairTool,
      };
    }
    return {
      ok: false,
      reason: initiallyOnCooldown ? "cooldown_no_ticket" : "nothing",
      readyAt: profile.mine_cooldown_at,
    };
  }
  return agg;
}

// 冷卻中主動使用一張 CD 縮短券：直接縮短目前的挖礦冷卻。
// 縮短量為 mining.cdTicketReductionMs（預設 30 分），不足則直接歸零（立即可挖）。
// 用條件式 updateOne 保證原子性，避免並發點按重複扣券。
async function useCdTicket(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  if ((profile.cd_ticket_count || 0) <= 0) {
    return { ok: false, reason: "no_ticket" };
  }
  if ((profile.mine_cooldown_at || 0) <= now) {
    return { ok: false, reason: "not_in_cooldown" };
  }

  // 每日使用上限（依 Asia/Taipei 跨日重置）
  const today = DateTime.now().setZone("Asia/Taipei").toISODate();
  const dailyLimit = mining?.cdTicketDailyUseLimit || 0;
  const usedToday =
    profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;
  if (dailyLimit > 0 && usedToday >= dailyLimit) {
    return { ok: false, reason: "daily_limit", limit: dailyLimit };
  }

  const reductionMs = mining?.cdTicketReductionMs || 0;
  const newCooldownAt = Math.max(now, profile.mine_cooldown_at - reductionMs);
  const clearedToReady = newCooldownAt <= now;

  // 原子更新：扣券 + 縮短冷卻 + 累計當日使用數（跨日自動歸零後再 +1）
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      cd_ticket_count: { $gte: 1 },
      mine_cooldown_at: { $gt: now },
    },
    [
      {
        $set: {
          cd_ticket_count: { $add: ["$cd_ticket_count", -1] },
          mine_cooldown_at: newCooldownAt,
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

  // 並發情況下沒改到任何文件：可能券剛被用掉或冷卻已結束，請重試
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
    pickaxe: profile.pickaxe,
    pickaxeDurability: profile.pickaxe_durability,
    pickaxeMaxDurability: profile.pickaxe_max_durability,
  };
}

// 依當前鎬子的合成配方計算材料修復所需材料。
// 成本 = 合成配方礦石各取一半（ceil），加固定 石頭×20、煤炭×10。
// 回傳 { stone: N, coal: N, iron?: N, gold?: N, diamond?: N } 或 null（木鎬）。
// bottleneck 級材料：修理時跳過（傳說碎片極稀缺、熔岩魚需 Lv.40 + 通關 10 次解鎖）
const REPAIR_SKIP_MATERIALS = new Set(["legendary_fragment", "lava_fish"]);

// 公會鐵匠鋪：對 cost 套整數百分比折扣，最低 1 個。
// 折扣為 0 / null 時直接回原 cost。
function applyRepairDiscount(cost, pct) {
  if (!cost) return null;
  const p = Number(pct) || 0;
  if (p <= 0) return cost;
  const out = {};
  for (const [mat, qty] of Object.entries(cost)) {
    out[mat] = Math.max(1, Math.ceil(qty * (1 - p / 100)));
  }
  return out;
}

function getPickaxeRepairCost(profile) {
  const { craft } = require("../../config");
  const pickaxeId = profile?.pickaxe;
  if (!pickaxeId || pickaxeId === "wood") return null;
  const recipeId = `pickaxe_${pickaxeId}`;
  const recipe = (craft?.recipes || []).find((r) => r.id === recipeId);
  if (!recipe) return null;
  // 固定基底加 iron 5，讓鑽石鎬也吃鐵（鐵礦全階級 sink）
  const cost = { stone: 20, coal: 10, iron: 5 };
  for (const [mat, qty] of Object.entries(recipe.materials || {})) {
    if (mat === "coal") continue;
    cost[mat] = (cost[mat] || 0) + Math.ceil(qty / 2);
  }
  return cost;
}

function getWeaponRepairCost(profile) {
  const { craft } = require("../../config");
  const weaponId = profile?.weapon;
  if (!weaponId || weaponId === "fist") return null;
  const recipe = (craft?.recipes || []).find(
    (r) => r.result?.type === "weapon" && r.result?.id === weaponId
  );
  if (!recipe) return null;
  const cost = { stone: 20, coal: 10, iron: 5 };
  for (const [mat, qty] of Object.entries(recipe.materials || {})) {
    if (mat === "coal") continue;
    if (REPAIR_SKIP_MATERIALS.has(mat)) continue;
    cost[mat] = (cost[mat] || 0) + Math.ceil(qty / 2);
  }
  return cost;
}

function getRodRepairCost(profile) {
  const { craft } = require("../../config");
  const rodId = profile?.fishing_rod;
  if (!rodId || rodId === "bamboo") return null;
  const recipe = (craft?.recipes || []).find(
    (r) => r.result?.type === "rod" && r.result?.id === rodId
  );
  if (!recipe) return null;
  const cost = { stone: 20, coal: 10, iron: 5 };
  for (const [mat, qty] of Object.entries(recipe.materials || {})) {
    if (mat === "coal") continue;
    if (REPAIR_SKIP_MATERIALS.has(mat)) continue;
    cost[mat] = (cost[mat] || 0) + Math.ceil(qty / 2);
  }
  return cost;
}

// 使用一個劣質磨石：補滿鎬子耐久到目前 pickaxe_max_durability，然後 max -10。
// max < 20 時拒用（避免降至 10 以下，讓玩家知道是最終次數）。
async function useInferiorWhetstone(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);

  if ((profile.whetstone_inferior_count || 0) <= 0) {
    return { ok: false, reason: "no_whetstone" };
  }
  if (!profile.pickaxe || profile.pickaxe === "wood") {
    return { ok: false, reason: "no_pickaxe" };
  }
  if (typeof profile.pickaxe_max_durability !== "number") {
    return { ok: false, reason: "no_pickaxe" };
  }
  if (profile.pickaxe_max_durability < 20) {
    return { ok: false, reason: "max_too_low", maxDurability: profile.pickaxe_max_durability };
  }

  // 原子更新：補滿耐久到新 max（舊 max - 10），扣一顆劣質磨石
  // pipeline $set 內所有運算式都參照「更新前」的文件值。
  //
  // 舊存檔玩家 DB 文件可能沒有 pickaxe_max_durability 欄位（miningProfile.normalize
  // 只在記憶體裡用 config 補回，沒寫回 DB），所以這裡：
  //   1) filter 不再要求 pickaxe_max_durability >= 20——前面 JS 已用 normalize 後
  //      的值預檢過，否則舊文件會卡在「操作衝突」。
  //   2) pipeline 內用 $ifNull 把可能 missing 的欄位 fallback 成 normalize 出來
  //      的 max（profile.pickaxe_max_durability），避免 $add(null,-10) → null
  //      把鎬子上限算成空值。
  const fallbackMax = profile.pickaxe_max_durability;
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      whetstone_inferior_count: { $gte: 1 },
      pickaxe: { $ne: "wood" },
    },
    [
      {
        $set: {
          pickaxe_max_durability: {
            $add: [{ $ifNull: ["$pickaxe_max_durability", fallbackMax] }, -10],
          },
          pickaxe_durability: {
            $add: [{ $ifNull: ["$pickaxe_max_durability", fallbackMax] }, -10],
          },
          whetstone_inferior_count: { $add: ["$whetstone_inferior_count", -1] },
          updatedAt: "$$NOW",
        },
      },
    ]
  );

  if (res.modifiedCount === 0) {
    return { ok: false, reason: "retry" };
  }

  const newMax = profile.pickaxe_max_durability - 10;
  return {
    ok: true,
    durabilityAfter: newMax,
    maxAfter: newMax,
    inferiorLeft: (profile.whetstone_inferior_count || 0) - 1,
  };
}

// Phase H+ 劣質磨石對武器：補滿武器耐久、武器 max -10、扣一顆劣質磨石。
// max < 20 時拒用（同鎬子規則，避免上限掉到負值）。
async function useInferiorWhetstoneOnWeapon(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const profile = await getOrCreate(client, userId, guildId);
  if ((profile.whetstone_inferior_count || 0) <= 0) return { ok: false, reason: "no_whetstone" };
  if (!profile.weapon || profile.weapon === "fist") return { ok: false, reason: "no_weapon" };
  if (typeof profile.weapon_max_durability !== "number") return { ok: false, reason: "no_weapon" };
  if (profile.weapon_max_durability < 20) {
    return { ok: false, reason: "max_too_low", maxDurability: profile.weapon_max_durability };
  }

  const fallbackMax = profile.weapon_max_durability;
  // 磨石 -10 作用在「原始上限」；補滿的當前耐久則補到「有效上限」（原始 × 鐵匠鋪加成）。
  const pct = await buildingService.getWeaponMaxDurabilityPct(client, userId, guildId);
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      whetstone_inferior_count: { $gte: 1 },
      weapon: { $ne: "fist" },
    },
    [
      {
        $set: {
          weapon_max_durability: {
            $add: [{ $ifNull: ["$weapon_max_durability", fallbackMax] }, -10],
          },
          weapon_durability: {
            $floor: {
              $multiply: [
                { $add: [{ $ifNull: ["$weapon_max_durability", fallbackMax] }, -10] },
                1 + pct / 100,
              ],
            },
          },
          whetstone_inferior_count: { $add: ["$whetstone_inferior_count", -1] },
          updatedAt: "$$NOW",
        },
      },
    ],
  );

  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };
  const newBase = profile.weapon_max_durability - 10;
  const newEffMax = buildingService.effectiveWeaponMaxDurability(newBase, pct);
  return {
    ok: true,
    durabilityAfter: newEffMax,
    maxAfter: newEffMax,
    inferiorLeft: (profile.whetstone_inferior_count || 0) - 1,
    weaponKey: profile.weapon,
  };
}

// Phase H+ 劣質磨石對盾：補滿盾耐久、盾 max -10、扣一顆劣質磨石。
async function useInferiorWhetstoneOnShield(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const profile = await getOrCreate(client, userId, guildId);
  if ((profile.whetstone_inferior_count || 0) <= 0) return { ok: false, reason: "no_whetstone" };
  if (!profile.shield) return { ok: false, reason: "no_shield" };
  if (typeof profile.shield_max_durability !== "number") return { ok: false, reason: "no_shield" };
  if (profile.shield_max_durability < 20) {
    return { ok: false, reason: "max_too_low", maxDurability: profile.shield_max_durability };
  }

  const fallbackMax = profile.shield_max_durability;
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      whetstone_inferior_count: { $gte: 1 },
      shield: { $ne: null },
    },
    [
      {
        $set: {
          shield_max_durability: {
            $add: [{ $ifNull: ["$shield_max_durability", fallbackMax] }, -10],
          },
          shield_durability: {
            $add: [{ $ifNull: ["$shield_max_durability", fallbackMax] }, -10],
          },
          whetstone_inferior_count: { $add: ["$whetstone_inferior_count", -1] },
          updatedAt: "$$NOW",
        },
      },
    ],
  );

  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };
  const newMax = profile.shield_max_durability - 10;
  return {
    ok: true,
    durabilityAfter: newMax,
    maxAfter: newMax,
    inferiorLeft: (profile.whetstone_inferior_count || 0) - 1,
    shieldKey: profile.shield,
  };
}

// 使用維修工具修復鎬子：依工具階級補 % 耐久、調整 max。
// 例：鋼製 +75% 當前 max、max -3；傳說 +100% 且 max +2。
// max 不能低於 10（避免變垃圾），低於 20 時不允許使用會降 max 的工具。
async function useRepairTool(client, { userId, guildId, tier }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const def = (craft?.repairTools || {})[tier];
  if (!def) return { ok: false, reason: "no_tool_def" };

  const profile = await getOrCreate(client, userId, guildId);
  const owned = (profile.repair_tools || {})[tier] || 0;
  if (owned <= 0) return { ok: false, reason: "no_tool", tier };
  if (!profile.pickaxe || profile.pickaxe === "wood") {
    return { ok: false, reason: "no_pickaxe" };
  }
  if (typeof profile.pickaxe_max_durability !== "number") {
    return { ok: false, reason: "no_pickaxe" };
  }
  const curMax = profile.pickaxe_max_durability;
  const maxDelta = def.maxDelta || 0;
  if (maxDelta < 0 && curMax + maxDelta < 10) {
    return { ok: false, reason: "max_too_low", maxDurability: curMax, after: curMax + maxDelta };
  }

  const newMax = Math.max(1, curMax + maxDelta);
  const restoreAmount = Math.ceil(newMax * (def.duraPct ?? 1));
  const newDura = Math.min(newMax, restoreAmount);

  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      pickaxe: { $ne: "wood" },
      [`repair_tools.${tier}`]: { $gte: 1 },
    },
    {
      $set: {
        pickaxe_max_durability: newMax,
        pickaxe_durability: newDura,
        updatedAt: new Date(),
      },
      $inc: { [`repair_tools.${tier}`]: -1 },
    },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };

  return {
    ok: true,
    tier,
    durabilityAfter: newDura,
    maxAfter: newMax,
    toolsLeft: owned - 1,
    def,
  };
}

// 使用礦石材料原地修復鎬子：補滿耐久至 pickaxe_max_durability，無懲罰。
// 成本為合成配方礦石各取一半（ceil）加石頭×20、煤炭×10。
async function repairPickaxeWithMaterials(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);

  if (!profile.pickaxe || profile.pickaxe === "wood") {
    return { ok: false, reason: "no_pickaxe" };
  }
  if (typeof profile.pickaxe_max_durability !== "number") {
    return { ok: false, reason: "no_pickaxe" };
  }
  if (
    typeof profile.pickaxe_durability === "number" &&
    profile.pickaxe_durability >= profile.pickaxe_max_durability
  ) {
    return { ok: false, reason: "already_full", durability: profile.pickaxe_durability };
  }

  const baseCost = getPickaxeRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const cost = applyRepairDiscount(
    baseCost,
    guildBuffs.equipment_repair_discount_pct || 0
  );

  // 檢查背包足量
  const bp = profile.backpack || {};
  const missing = [];
  for (const [mat, need] of Object.entries(cost)) {
    const have = bp[mat] || 0;
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, cost };
  }

  // 原子更新：扣材料 + 補滿耐久
  const inc = {};
  for (const [mat, need] of Object.entries(cost)) {
    inc[`backpack.${mat}`] = -need;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        pickaxe_durability: profile.pickaxe_max_durability,
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    cost,
    durabilityAfter: profile.pickaxe_max_durability,
    maxDurability: profile.pickaxe_max_durability,
  };
}

// 武器材料修復：補滿耐久至 weapon_max_durability，無懲罰。
async function repairWeaponWithMaterials(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);

  if (!profile.weapon || profile.weapon === "fist") {
    return { ok: false, reason: "no_weapon" };
  }
  if (typeof profile.weapon_max_durability !== "number") {
    return { ok: false, reason: "no_weapon" };
  }
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const effMax = buildingService.effectiveWeaponMaxDurability(
    profile.weapon_max_durability,
    guildBuffs.weapon_max_durability_pct || 0
  );
  if (
    typeof profile.weapon_durability === "number" &&
    profile.weapon_durability >= effMax
  ) {
    return { ok: false, reason: "already_full", durability: profile.weapon_durability };
  }

  const baseCost = getWeaponRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const cost = applyRepairDiscount(
    baseCost,
    guildBuffs.equipment_repair_discount_pct || 0
  );

  const bp = profile.backpack || {};
  const missing = [];
  for (const [mat, need] of Object.entries(cost)) {
    const have = bp[mat] || 0;
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, cost };
  }

  const inc = {};
  for (const [mat, need] of Object.entries(cost)) {
    inc[`backpack.${mat}`] = -need;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        weapon_durability: effMax,
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    cost,
    durabilityAfter: effMax,
    maxDurability: effMax,
  };
}

// 釣竿材料修復的「成本預覽」（唯讀，不扣材料）：供連續釣魚的修理按鈕介面顯示要花多少材料。
// 回傳 { ok, cost, items:[{mat,need,have,isFish}], affordable } 或 { ok:false, reason }。
async function getRodRepairPreview(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const { fishing } = require("../../config");
  const profile = await getOrCreate(client, userId, guildId);
  if (!profile.fishing_rod || profile.fishing_rod === "bamboo") {
    return { ok: false, reason: "no_rod" };
  }
  const baseCost = getRodRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const cost = applyRepairDiscount(baseCost, guildBuffs.equipment_repair_discount_pct || 0);

  const bp = profile.backpack || {};
  const fb = profile.fish_bag || {};
  const fishDefs = fishing?.fish || {};
  const isFish = (mat) => !!fishDefs[mat];
  const items = [];
  let affordable = true;
  for (const [mat, need] of Object.entries(cost)) {
    const have = isFish(mat) ? fb[mat] || 0 : bp[mat] || 0;
    if (have < need) affordable = false;
    items.push({ mat, need, have, isFish: isFish(mat) });
  }
  return { ok: true, cost, items, affordable };
}

// 釣竿材料修復：補滿耐久至 rod_max_durability，無懲罰。
// 配方含魚類材料時從 fish_bag 扣（如黃金竿吃 shark），礦石類從 backpack 扣。
async function repairRodWithMaterials(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const { fishing } = require("../../config");

  const profile = await getOrCreate(client, userId, guildId);

  if (!profile.fishing_rod || profile.fishing_rod === "bamboo") {
    return { ok: false, reason: "no_rod" };
  }
  if (typeof profile.rod_max_durability !== "number") {
    return { ok: false, reason: "no_rod" };
  }
  if (
    typeof profile.rod_durability === "number" &&
    profile.rod_durability >= profile.rod_max_durability
  ) {
    return { ok: false, reason: "already_full", durability: profile.rod_durability };
  }

  const baseCost = getRodRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const cost = applyRepairDiscount(
    baseCost,
    guildBuffs.equipment_repair_discount_pct || 0
  );

  const bp = profile.backpack || {};
  const fb = profile.fish_bag || {};
  const fishDefs = fishing?.fish || {};
  const isFish = (mat) => !!fishDefs[mat];

  const missing = [];
  for (const [mat, need] of Object.entries(cost)) {
    const have = isFish(mat) ? (fb[mat] || 0) : (bp[mat] || 0);
    if (have < need) missing.push({ mat, need, have });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, cost };
  }

  const inc = {};
  for (const [mat, need] of Object.entries(cost)) {
    if (isFish(mat)) {
      inc[`fish_bag.${mat}`] = -need;
    } else {
      inc[`backpack.${mat}`] = -need;
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        rod_durability: profile.rod_max_durability,
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    cost,
    durabilityAfter: profile.rod_max_durability,
    maxDurability: profile.rod_max_durability,
  };
}

module.exports = {
  mine,
  mineBatch,
  isBatchPassActive,
  activateMiningPass,
  useCdTicket,
  getPickaxeRepairCost,
  getWeaponRepairCost,
  getRodRepairCost,
  applyRepairDiscount,
  useInferiorWhetstone,
  useInferiorWhetstoneOnWeapon,
  useInferiorWhetstoneOnShield,
  useRepairTool,
  repairPickaxeWithMaterials,
  repairWeaponWithMaterials,
  repairRodWithMaterials,
  getRodRepairPreview,
};
