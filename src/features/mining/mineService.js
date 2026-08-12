require("colors");
const { DateTime } = require("luxon");
const { mining, craft } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed, ORE_KEYS, isBatchPassActive } = require("./miningProfile");
const dropTable = require("./dropTable");
const freeActions = require("./freeActions");
const unifiedBuffResolver = require("../buff/buffResolver");
const encounterService = require("./encounterService");
const { consumeMineLuckUse, formatFoodBuffLines } = require("../fishing/cookService");
const grantCoins = require("../economy/grantCoins");
const grantActivityXp = require("../leveling/grantActivityXp");
const { priceOf } = require("./overflowConfirm");
const buildingService = require("../guild_club/buildingService");
const {
  EQUIP_SLOTS,
  MIN_BASE_WITH_BONUS,
  baseWithBonus,
  bonusOf,
  effectiveMaxOf,
  slotEquipped,
} = require("./equipDurability");
const bus = require("../eventBus");

// 鎬子有效耐久上限：DB 只存原始 base，鐵匠鋪加成讀取時才換算。
const effectivePickaxeMax = (client, userId, guildId, profile) =>
  buildingService
    .getEquipmentMaxDurabilityPct(client, userId, guildId)
    .then((pct) => effectiveMaxOf(profile, "pickaxe", pct));

// 啟用一張連續通行證：扣一張、寫入 expires_at（同時解鎖連續挖礦與連續釣魚）。
// 已在生效中則不重複啟用（避免浪費）。isBatchPassActive 定義於 miningProfile（挖礦／釣魚共用）。
async function activateBatchPass(client, { userId, guildId }) {
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();
  if ((profile.batch_pass_expires_at || 0) > now) {
    return { ok: false, reason: "already_active", expiresAt: profile.batch_pass_expires_at };
  }
  if ((profile.batch_pass_count || 0) < 1) {
    return { ok: false, reason: "no_pass" };
  }
  const durationMs = mining?.batch?.passDurationMs || 3600000;
  const expiresAt = now + durationMs;
  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      batch_pass_count: { $gte: 1 },
      $or: [{ batch_pass_expires_at: { $lte: now } }, { batch_pass_expires_at: { $exists: false } }],
    },
    { $inc: { batch_pass_count: -1 }, $set: { batch_pass_expires_at: expiresAt, updatedAt: new Date() } },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };
  const after = await client.miningProfilesCollection
    .findOne({ userId, guildId }, { projection: { batch_pass_count: 1 } })
    .catch(() => null);
  return { ok: true, expiresAt, passesLeft: after?.batch_pass_count || 0 };
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

  // 冷卻中：Twitch 訂閱者先吃每日免冷卻次數（免費、不動冷卻），用完才回冷卻錯誤。
  const onCooldown = (profile.mine_cooldown_at || 0) > now;
  const free = freeActions.resolve("mine", profile, member);
  const cooldownResult = async () => {
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
      freeMineLimit: free.limit,
      freeMineLeft: 0,
      pickaxe: profile.pickaxe,
      pickaxeDurability: profile.pickaxe_durability,
      pickaxeMaxDurability: await effectivePickaxeMax(client, userId, guildId, profile),
      backpackCap: cdCap,
      backpackUsed: cdUsed,
      backpackFree: Math.max(0, cdCap - cdUsed),
    };
  };
  if (onCooldown && free.left <= 0) return cooldownResult();

  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap && !allowOverflow) {
    return { ok: false, reason: "backpack_full", used, cap };
  }

  // 額度真正扣在這裡：背包滿等前置檢查都過了才扣，避免白白吃掉一次。
  const usedFreeMine = onCooldown && (await freeActions.claim(client, userId, guildId, free));
  if (onCooldown && !usedFreeMine) return cooldownResult();

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

  // 免冷卻次數是「無視冷卻插隊挖一次」，原本的冷卻繼續跑，不被這次挖礦重設。
  const newCooldownAt = usedFreeMine ? profile.mine_cooldown_at : now + buff.actualCdMs;

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
    usedFreeMine,
    freeMineLimit: free.limit,
    freeMineLeft: usedFreeMine ? free.left - 1 : free.left,
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
        passCount: profile.batch_pass_count || 0,
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
    freeMinesSpent: 0,
    stoppedNoTicket: false,
    freeExhausted: false,
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
          free_mine_used_date: 1,
          free_mine_used_count: 1,
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
    // 訂閱者的免冷卻次數比券便宜，還有額度就不動券——交給 mine() 自己扣。
    const freeNow = remaining > 0 ? freeActions.resolve("mine", cur, member) : null;
    if (remaining > 0 && freeNow.left <= 0) {
      const need = Math.ceil(remaining / reductionMs);
      if ((cur?.cd_ticket_count || 0) < need) {
        agg.stoppedNoTicket = true;
        agg.freeExhausted = freeNow.limit > 0;
        break;
      }
      const res = await client.miningProfilesCollection.updateOne(
        { userId, guildId, cd_ticket_count: { $gte: need } },
        { $inc: { cd_ticket_count: -need }, $set: { mine_cooldown_at: 0, updatedAt: new Date() } },
      );
      if (res.modifiedCount === 0) {
        agg.stoppedNoTicket = true;
        agg.freeExhausted = freeNow.limit > 0;
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
    if (r.usedFreeMine) agg.freeMinesSpent++;
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
      free: freeActions.resolve("mine", profile, member),
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
    pickaxeMaxDurability: await effectivePickaxeMax(client, userId, guildId, profile),
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

function getShieldRepairCost(profile) {
  const { craft } = require("../../config");
  const shieldId = profile?.shield;
  if (!shieldId) return null;
  const recipe = (craft?.recipes || []).find(
    (r) => r.result?.type === "shield" && r.result?.id === shieldId
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

// 劣質磨石：補滿耐久、上限 -10、扣一顆。四種裝備規則一致，差別只在欄位名（EQUIP_SLOTS），
// 所以只留一份實作。-10 累加到 bonus 欄位而不是 base，跟維修工具走同一套帳：
// base 永遠是 config 原始上限，升級換裝備時 bonus 不重設，磨損與補強都一路帶著走。
// base+bonus < 20 時拒用（避免降到 10 以下，讓玩家知道是最終次數）。
const WHETSTONE_MAX_DELTA = -10;
const WHETSTONE_MIN_BASE = 20;

async function useInferiorWhetstoneOn(client, { userId, guildId, target }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const spec = EQUIP_SLOTS[target];
  if (!spec) return { ok: false, reason: "no_target" };

  const profile = await getOrCreate(client, userId, guildId);
  if ((profile.whetstone_inferior_count || 0) <= 0) return { ok: false, reason: "no_whetstone" };
  if (!slotEquipped(profile, target)) return { ok: false, reason: spec.reason };

  const curBaseWithBonus = baseWithBonus(profile, target);
  if (curBaseWithBonus < WHETSTONE_MIN_BASE) {
    return { ok: false, reason: "max_too_low", maxDurability: curBaseWithBonus, target };
  }

  const pct = await buildingService.getEquipmentMaxDurabilityPct(client, userId, guildId);
  const newBonus = bonusOf(profile, target) + WHETSTONE_MAX_DELTA;
  const effMaxAfter =
    buildingService.effectiveMaxDurability(profile[spec.maxField], pct) + newBonus;

  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      whetstone_inferior_count: { $gte: 1 },
      [spec.idField]: profile[spec.idField],
    },
    {
      $set: {
        [spec.maxField]: profile[spec.maxField],
        [spec.bonusField]: newBonus,
        [spec.duraField]: effMaxAfter,
        updatedAt: new Date(),
      },
      $inc: { whetstone_inferior_count: -1 },
    },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };

  return {
    ok: true,
    target,
    durabilityAfter: effMaxAfter,
    maxAfter: effMaxAfter,
    bonusAfter: newBonus,
    inferiorLeft: (profile.whetstone_inferior_count || 0) - 1,
    ...(target === "weapon" ? { weaponKey: profile.weapon } : {}),
    ...(target === "shield" ? { shieldKey: profile.shield } : {}),
  };
}

const useInferiorWhetstone = (client, opts) =>
  useInferiorWhetstoneOn(client, { ...opts, target: "pickaxe" });
const useInferiorWhetstoneOnWeapon = (client, opts) =>
  useInferiorWhetstoneOn(client, { ...opts, target: "weapon" });
const useInferiorWhetstoneOnShield = (client, opts) =>
  useInferiorWhetstoneOn(client, { ...opts, target: "shield" });

// 使用維修工具修復鎬子：依工具階級補 % 耐久、調整 max。
// 例：鋼製 +75% 當前 max、max -3；傳說 +100% 且 max +2。
// max 不能低於 10（避免變垃圾），低於 20 時不允許使用會降 max 的工具。
// 維修工具可作用的四種裝備 = 有耐久的四個欄位，欄位定義與有效上限換算共用 equipDurability。
const REPAIR_TOOL_TARGETS = EQUIP_SLOTS;
const repairToolTargetEquipped = slotEquipped;

async function useRepairTool(client, { userId, guildId, tier, target = "pickaxe" }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const def = (craft?.repairTools || {})[tier];
  if (!def) return { ok: false, reason: "no_tool_def" };
  const spec = REPAIR_TOOL_TARGETS[target];
  if (!spec) return { ok: false, reason: "no_target" };

  const profile = await getOrCreate(client, userId, guildId);
  const owned = (profile.repair_tools || {})[tier] || 0;
  if (owned <= 0) return { ok: false, reason: "no_tool", tier };
  if (!repairToolTargetEquipped(profile, target)) {
    return { ok: false, reason: spec.reason, target };
  }

  // maxDelta 一律累加到 bonus 欄位，不動 maxField（maxField 永遠是該裝備 config 的原始上限）。
  // 這樣升級 / 打造覆蓋 maxField 時，維修工具累積的 ±值不會被沖掉，能一路帶到下一階裝備。
  // 補耐久時要補到「有效上限」，否則裝了鐵匠鋪加成反而補不滿；「不得低於 10」的門檻看 base+bonus。
  const maxDelta = def.maxDelta || 0;
  const pct = await buildingService.getEquipmentMaxDurabilityPct(client, userId, guildId);
  const curBonus = bonusOf(profile, target);
  const curBaseWithBonus = baseWithBonus(profile, target);
  if (maxDelta < 0 && curBaseWithBonus + maxDelta < MIN_BASE_WITH_BONUS) {
    return {
      ok: false, reason: "max_too_low", target,
      maxDurability: effectiveMaxOf(profile, target, pct),
      after: effectiveMaxOf(profile, target, pct) + maxDelta,
    };
  }

  const newBonus = curBonus + maxDelta;
  const fillMax = buildingService.effectiveMaxDurability(profile[spec.maxField], pct) + newBonus;
  const newDura = Math.min(fillMax, Math.ceil(fillMax * (def.duraPct ?? 1)));

  const res = await client.miningProfilesCollection.updateOne(
    {
      userId,
      guildId,
      [spec.idField]: profile[spec.idField],
      [`repair_tools.${tier}`]: { $gte: 1 },
    },
    {
      $set: {
        [spec.maxField]: profile[spec.maxField],
        [spec.bonusField]: newBonus,
        [spec.duraField]: newDura,
        updatedAt: new Date(),
      },
      $inc: { [`repair_tools.${tier}`]: -1 },
    },
  );
  if (res.modifiedCount === 0) return { ok: false, reason: "retry" };

  return {
    ok: true,
    tier,
    target,
    targetLabel: spec.label,
    targetEmoji: spec.emoji,
    durabilityAfter: newDura,
    maxAfter: fillMax,
    baseMaxAfter: profile[spec.maxField] + newBonus,
    bonusAfter: newBonus,
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
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const effMax = effectiveMaxOf(profile, "pickaxe", guildBuffs.equipment_max_durability_pct || 0);
  if (
    typeof profile.pickaxe_durability === "number" &&
    profile.pickaxe_durability >= effMax
  ) {
    return { ok: false, reason: "already_full", durability: profile.pickaxe_durability };
  }

  const baseCost = getPickaxeRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
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
        pickaxe_durability: effMax,
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
  const effMax = effectiveMaxOf(profile, "weapon", guildBuffs.equipment_max_durability_pct || 0);
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
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const effMax = effectiveMaxOf(profile, "rod", guildBuffs.equipment_max_durability_pct || 0);
  if (
    typeof profile.rod_durability === "number" &&
    profile.rod_durability >= effMax
  ) {
    return { ok: false, reason: "already_full", durability: profile.rod_durability };
  }

  const baseCost = getRodRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
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
        rod_durability: effMax,
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

async function getShieldRepairPreview(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  const profile = await getOrCreate(client, userId, guildId);
  if (!profile.shield) return { ok: false, reason: "no_shield" };
  const baseCost = getShieldRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const cost = applyRepairDiscount(baseCost, guildBuffs.equipment_repair_discount_pct || 0);

  const bp = profile.backpack || {};
  const items = [];
  let affordable = true;
  for (const [mat, need] of Object.entries(cost)) {
    const have = bp[mat] || 0;
    if (have < need) affordable = false;
    items.push({ mat, need, have, isFish: false });
  }
  return { ok: true, cost, items, affordable };
}

// 盾牌材料修復：補滿耐久至 shield_max_durability，無懲罰。
// 盾原本只有劣質磨石一條路（補滿但 max -10），是四種裝備裡唯一沒有材料修復的。
async function repairShieldWithMaterials(client, { userId, guildId }) {
  if (!mining?.enabled || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }

  const profile = await getOrCreate(client, userId, guildId);

  if (!profile.shield) return { ok: false, reason: "no_shield" };
  if (typeof profile.shield_max_durability !== "number") {
    return { ok: false, reason: "no_shield" };
  }
  const guildBuffs = await buildingService
    .getMemberBuildingBuffs(client, userId, guildId)
    .catch(() => ({}));
  const effMax = effectiveMaxOf(profile, "shield", guildBuffs.equipment_max_durability_pct || 0);
  if (
    typeof profile.shield_durability === "number" &&
    profile.shield_durability >= effMax
  ) {
    return { ok: false, reason: "already_full", durability: profile.shield_durability };
  }

  const baseCost = getShieldRepairCost(profile);
  if (!baseCost) return { ok: false, reason: "no_recipe" };
  const cost = applyRepairDiscount(
    baseCost,
    guildBuffs.equipment_repair_discount_pct || 0
  );

  const bp = profile.backpack || {};
  const missing = [];
  for (const [mat, need] of Object.entries(cost)) {
    if ((bp[mat] || 0) < need) missing.push({ mat, need, have: bp[mat] || 0 });
  }
  if (missing.length > 0) {
    return { ok: false, reason: "insufficient", missing, cost };
  }

  const inc = {};
  for (const [mat, need] of Object.entries(cost)) inc[`backpack.${mat}`] = -need;

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    {
      $inc: inc,
      $set: {
        shield_durability: effMax,
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

module.exports = {
  mine,
  mineBatch,
  isBatchPassActive,
  activateBatchPass,
  useCdTicket,
  getPickaxeRepairCost,
  getWeaponRepairCost,
  getShieldRepairCost,
  getShieldRepairPreview,
  repairShieldWithMaterials,
  getRodRepairCost,
  applyRepairDiscount,
  useInferiorWhetstone,
  useInferiorWhetstoneOnWeapon,
  useInferiorWhetstoneOnShield,
  useRepairTool,
  REPAIR_TOOL_TARGETS,
  repairToolTargetEquipped,
  repairPickaxeWithMaterials,
  repairWeaponWithMaterials,
  repairRodWithMaterials,
  getRodRepairPreview,
};
