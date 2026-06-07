require("colors");
const { DateTime } = require("luxon");
const { mining } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const dropTable = require("./dropTable");
const unifiedBuffResolver = require("../buff/buffResolver");
const encounterService = require("./encounterService");
const { consumeMineLuckUse } = require("../fishing/cookService");
const grantCoins = require("../economy/grantCoins");
const { priceOf } = require("./overflowConfirm");
const bus = require("../eventBus");

// 執行一次挖礦。回傳結果物件交由指令層呈現（含彩虹石公告與耐久 DM 所需資料）。
// allowOverflow=true：背包滿時不擋；roll 出的礦能放多少放多少，溢出折成系統收購價金幣。
async function mine(client, { userId, guildId, member, username, allowOverflow = false }) {
  if (!mining?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const profile = await getOrCreate(client, userId, guildId);
  const now = Date.now();

  if ((profile.mine_cooldown_at || 0) > now) {
    const today = DateTime.now().setZone("Asia/Taipei").toISODate();
    const dailyLimit = mining?.cdTicketDailyUseLimit || 0;
    const usedToday =
      profile.cd_ticket_used_date === today ? profile.cd_ticket_used_count || 0 : 0;
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
    member
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

  client.mineLogsCollection
    ?.insertOne({ user_id: userId, guild_id: guildId, ore, qty: qty + overflowQty, ts: new Date() })
    .catch((e) => console.log(`[ERROR] insert mine log: ${e}`.red));

  // 食物 buff：若 mine_luck uses 型 buff 生效，異步消耗一次使用次數
  if (buff.foodLuckBonus > 0) {
    consumeMineLuckUse(client, userId, guildId, profile).catch(() => {});
  }

  const result = {
    ok: true,
    ore,
    qty,
    overflowQty,
    overflowCoins,
    buff,
    newCooldownAt,
    pickaxeBefore: profile.pickaxe,
    durabilityBroke,
    durabilityAfter,
    durabilityWarnCrossed,
    mineCountTotal: (profile.mine_count_total || 0) + 1,
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
  }

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
  if (appraisalEligible) {
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

// 使用一個劣質磨鎬石：補滿鎬子耐久到目前 pickaxe_max_durability，然後 max -10。
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

  // 原子更新：補滿耐久到新 max（舊 max - 10），扣一顆磨鎬石
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

  const cost = getPickaxeRepairCost(profile);
  if (!cost) return { ok: false, reason: "no_recipe" };

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
  if (
    typeof profile.weapon_durability === "number" &&
    profile.weapon_durability >= profile.weapon_max_durability
  ) {
    return { ok: false, reason: "already_full", durability: profile.weapon_durability };
  }

  const cost = getWeaponRepairCost(profile);
  if (!cost) return { ok: false, reason: "no_recipe" };

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
        weapon_durability: profile.weapon_max_durability,
        updatedAt: new Date(),
      },
    }
  );

  return {
    ok: true,
    cost,
    durabilityAfter: profile.weapon_max_durability,
    maxDurability: profile.weapon_max_durability,
  };
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

  const cost = getRodRepairCost(profile);
  if (!cost) return { ok: false, reason: "no_recipe" };

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
  useCdTicket,
  getPickaxeRepairCost,
  getWeaponRepairCost,
  getRodRepairCost,
  useInferiorWhetstone,
  repairPickaxeWithMaterials,
  repairWeaponWithMaterials,
  repairRodWithMaterials,
};
