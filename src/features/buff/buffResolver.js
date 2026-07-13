// 統一 buff 解析門面。
//
// 目的：把散落各處的加成來源（鎬子 / 幸運藥水 / Twitch 訂閱 / 伺服器加成 /
// 抖內 / 商店 buff…）收斂成單一查詢入口，供決鬥、地城、挖礦與 /buff 總覽使用。
// 未來新增 buff 來源（公會 Phase A、技能 Phase S3、食物 S4、活動 S5）時，
// 只需在此檔對應分支擴充，呼叫端不需改動，也不應再直接讀 UserCoins.activeBuffs。
//
// 注意：金幣倍率的「實際套用」仍由 grantCoins 負責（load-bearing 的集中點）；
// 這裡的 getEffectiveIncomeMultiplier 提供統一「查詢」口徑，供 summary / 未來來源彙整。

const miningResolve = require("../mining/buffResolver"); // resolve(profile, member)
const { playerAtk } = require("../mining/dungeonService");
const { getOrCreate } = require("../mining/miningProfile");
const {
  getCoinTwitchSubBonus,
  getCoinServerBoostBonus,
} = require("../economy/coinMultiplier");
const { getActiveBuffMultiplier } = require("../shop/activeBuff");
const eventEngine = require("../event/eventEngine");
const twitchPerks = require("../mining/twitchPerks");
const {
  getFoodFarmYieldBonus,
  getFoodFishingCdBonus,
  getFoodMiningCdBonus,
} = require("../fishing/cookService");
const { MONEY_EMOJI } = require("../../constants/coin");
const { donation, levelSystem, guildClub, fishing } = require("../../config");
const buildingService = require("../guild_club/buildingService");
const worldEventBuffs = require("../world_event/worldEventBuffs");

// ── 公會共享 buff ────────────────────────────────────
// 讀取使用者所屬公會 + 等級對應的 buff 清單，回傳結構化資料。
// 失敗或無公會 → 回傳空 buffs，呼叫端統一處理。
async function getGuildClubBuffs(client, userId, guildId) {
  const empty = { club: null, level: 0, buffs: [], buffsByType: {} };
  if (!guildClub?.enabled) return empty;
  if (!client.guildClubMembersCollection || !client.guildsClubCollection) return empty;
  const member = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!member) return empty;
  const club = await client.guildsClubCollection
    .findOne({ guild_club_id: member.guild_club_id, disbanded_at: null })
    .catch(() => null);
  if (!club) return empty;
  const def = guildClub.levels.find((l) => l.level === club.level);
  const buffs = def?.buffs || [];
  const buffsByType = {};
  for (const b of buffs) {
    buffsByType[b.type] = (buffsByType[b.type] || 0) + (b.value || 0);
  }
  // 疊加公會建築（礦坑 / 訓練場）buff；倉庫擴建另外處理（容量加成）。
  const fromBuildings = buildingService.buildingsBuffs(club);
  for (const [k, v] of Object.entries(fromBuildings)) {
    buffsByType[k] = (buffsByType[k] || 0) + v;
  }
  // 公會宴會：時效內把宴會的 buff 加進來，過期就忽略。
  const banquet = club.active_banquet;
  let activeBanquet = null;
  if (banquet && typeof banquet.expires_at === "number" && banquet.expires_at > Date.now()) {
    for (const b of banquet.buffs || []) {
      buffsByType[b.type] = (buffsByType[b.type] || 0) + (b.value || 0);
    }
    activeBanquet = banquet;
  }
  return {
    club,
    level: club.level,
    buffs,
    buffsByType,
    buildingBuffs: fromBuildings,
    activeBanquet,
  };
}

// ── ATK ───────────────────────────────────────────────
// 目前 = baseAtk + 鎬子加成；未來食物 / 技能 / 活動 buff 在此加分支。
function atkFromProfile(profile) {
  return playerAtk(profile);
}

async function getEffectiveAtk(client, userId, guildId) {
  const profile = await getOrCreate(client, userId, guildId);
  return atkFromProfile(profile);
}

// ── LUCK / 挖礦數量 / CD ──────────────────────────────
// 沿用 mining/buffResolver.resolve（鎬子 + 藥水 + Twitch + 抖內，已套 luckCap）。
// 公會 luck / qty 加成在這層加總，與 donation / event / food 同列為「luckCap 外」追加。
async function getMiningResolve(client, userId, guildId, member) {
  const profile = await getOrCreate(client, userId, guildId);
  const base = miningResolve.resolve(profile, member);
  const gc = await getGuildClubBuffs(client, userId, guildId);
  const guildLuck = gc.buffsByType.mining_luck_pct || 0;
  const guildQty = gc.buffsByType.mining_qty_bonus || 0;
  if (guildLuck > 0) base.luckBonus += guildLuck;
  if (guildQty > 0) base.qtyBonus += guildQty;
  base.guildClubLuckBonus = guildLuck;
  base.guildClubQtyBonus = guildQty;
  // 公會建築 mining_cooldown_pct + 世界事件 mining_cooldown_pct
  const buildingCdPct = gc.buffsByType.mining_cooldown_pct || 0;
  const worldBuffs = worldEventBuffs.getCachedBuffs();
  const worldLuckPct = (worldBuffs.mining_luck_pct || 0) / 100;
  if (worldLuckPct > 0) base.luckBonus += worldLuckPct;
  const worldQty = worldBuffs.mining_qty_bonus || 0;
  if (worldQty > 0) base.qtyBonus += worldQty;
  const worldCdPct = worldBuffs.mining_cooldown_pct || 0;
  const foodCdPct = (getFoodMiningCdBonus(profile) || 0) * 100;
  const totalCdPct = Math.min(70, buildingCdPct + worldCdPct + foodCdPct);
  if (totalCdPct > 0) {
    base.actualCdMs = Math.max(60000, Math.floor(base.actualCdMs * (100 - totalCdPct) / 100));
  }
  base.guildBuildingCdPct = buildingCdPct;
  base.worldEventCdPct = worldCdPct;
  base.foodCdPct = foodCdPct;
  base.guildClub = gc.club
    ? { id: gc.club.guild_club_id, name: gc.club.name, level: gc.level }
    : null;
  return base;
}

async function getEffectiveLuck(client, userId, guildId, member) {
  return (await getMiningResolve(client, userId, guildId, member)).luckBonus;
}

async function getEffectiveCdMs(client, userId, guildId, member, source = "mine") {
  if (source === "mine") {
    return (await getMiningResolve(client, userId, guildId, member)).actualCdMs;
  }
  if (source === "fish") {
    return (await getFishingResolve(client, userId, guildId, member)).actualCdMs;
  }
  return null; // 其他來源尚無 CD 減免
}

// ── 釣魚冷卻 ──────────────────────────────────────────
// 固定毫秒（釣竿 + Twitch 訂閱 + 贊助身分組）先扣，再套百分比（公會建築/等級/宴會 +
// 世界事件 + 食物 buff），最後保底 60 秒。與挖礦同構：存來源、用時即時算，不寫死進 DB。
function applyFishingCdReduction({ baseCdMs, fixedCdMs, cdPct }) {
  let cdMs = (baseCdMs || 0) - (fixedCdMs || 0);
  const totalCdPct = Math.min(70, cdPct || 0);
  if (totalCdPct > 0) cdMs = Math.floor((cdMs * (100 - totalCdPct)) / 100);
  return { actualCdMs: Math.max(60000, cdMs), totalCdPct };
}

// 贊助身分組的釣魚冷卻固定減免（VIP 優先，取單一最高檔，不與一般贊助疊加）。
function donationFishingCdMs(member) {
  if (!member?.roles?.cache) return 0;
  const cfg = donation?.fishingCdReductionMs || {};
  const ids = donation?.roleIds || {};
  if (ids.vipDonor && member.roles.cache.has(ids.vipDonor)) return cfg.vipDonor || 0;
  if (ids.donor && member.roles.cache.has(ids.donor)) return cfg.donor || 0;
  return 0;
}

// 釣魚冷卻各來源即時解析。供 fishService 套用、/加成 顯示。
// opts.profile / opts.gc 省略時自行讀取；呼叫端已有就傳入避免重複查詢。
async function getFishingResolve(client, userId, guildId, member, opts = {}) {
  const profile = opts.profile || (await getOrCreate(client, userId, guildId));
  const gc = opts.gc || (await getGuildClubBuffs(client, userId, guildId));
  const rods = fishing?.rods || {};
  const rod = rods[profile?.fishing_rod || "bamboo"] || rods.bamboo || {};

  const rodCdMs = rod.cdReductionMs || 0;
  const twitchCdMs = twitchPerks.resolvePerks(member)?.fishingCdReductionMs || 0;
  const donationCdMs = donationFishingCdMs(member);

  const guildCdPct = gc.buffsByType.fishing_cooldown_pct || 0;
  const worldCdPct = worldEventBuffs.getCachedBuffs().fishing_cooldown_pct || 0;
  const foodCdPct = (getFoodFishingCdBonus(profile) || 0) * 100;

  const { actualCdMs, totalCdPct } = applyFishingCdReduction({
    baseCdMs: fishing?.cooldownMs || 0,
    fixedCdMs: rodCdMs + twitchCdMs + donationCdMs,
    cdPct: guildCdPct + worldCdPct + foodCdPct,
  });

  return { actualCdMs, rodCdMs, twitchCdMs, donationCdMs, guildCdPct, worldCdPct, foodCdPct, totalCdPct };
}

// ── INCOME 倍率（查詢用，套用仍在 grantCoins）────────────
// 公會 work_income_multiplier 只在 source === "work" 時生效，與其他倍率累乘。
async function getEffectiveIncomeMultiplier(client, userId, guildId, member, source) {
  const tw = getCoinTwitchSubBonus(member, source)?.multiplier || 1;
  const boost = getCoinServerBoostBonus(member, source)?.multiplier || 1;
  const coinBuff = await getActiveBuffMultiplier(
    client,
    userId,
    guildId,
    "coin_boost"
  ).catch(() => 1);
  let guildWork = 1;
  if (source === "work") {
    const gc = await getGuildClubBuffs(client, userId, guildId);
    const v = gc.buffsByType.work_income_multiplier || 0;
    if (v > 0) guildWork = 1 + v;
  }
  return tw * boost * coinBuff * guildWork;
}

// ── SUMMARY（/buff 指令用：列所有來源）──────────────────
async function summary(client, userId, guildId, member) {
  const profile = await getOrCreate(client, userId, guildId);
  const m = miningResolve.resolve(profile, member);
  const [coinBuff, xpBuff, gc] = await Promise.all([
    getActiveBuffMultiplier(client, userId, guildId, "coin_boost").catch(() => 1),
    getActiveBuffMultiplier(client, userId, guildId, "xp_boost").catch(() => 1),
    getGuildClubBuffs(client, userId, guildId),
  ]);
  const guildLuck = gc.buffsByType.mining_luck_pct || 0;
  const guildQty = gc.buffsByType.mining_qty_bonus || 0;
  const guildWork = gc.buffsByType.work_income_multiplier || 0;
  const guildStaminaMax = gc.buffsByType.dungeon_stamina_max || 0;
  const guildBossAtk = gc.buffsByType.boss_atk_pct || 0;
  const guildBossAttackLimitBonus = gc.buffsByType.boss_attack_limit_bonus || 0;
  const guildMiningCdPct = gc.buffsByType.mining_cooldown_pct || 0;
  const guildFishingCdPct = gc.buffsByType.fishing_cooldown_pct || 0;
  const guildDungeonDmgPct = gc.buffsByType.dungeon_damage_pct || 0;
  const guildCritPct = gc.buffsByType.crit_rate_pct || 0;
  const guildBossDmgPct = gc.buffsByType.boss_damage_pct || 0;
  const guildFarmGrowthCutPct = gc.buffsByType.farm_growth_reduction_pct || 0;
  const guildHarvestCoinPct = gc.buffsByType.harvest_coin_pct || 0;
  const guildCookingCritPct = gc.buffsByType.cooking_crit_pct || 0;
  const guildFarmLowTierExtra = gc.buffsByType.farm_low_tier_extra_count || 0;
  const guildWeaponMaxDurPct = gc.buffsByType.weapon_max_durability_pct || 0;
  const guildRepairDiscountPct = gc.buffsByType.equipment_repair_discount_pct || 0;
  const guildCombatDurSavePct = gc.buffsByType.combat_durability_save_pct || 0;
  const guildWhBonus = gc.club ? buildingService.warehouseCapacityBonus(gc.club) : 0;
  const { actualCdMs: fishingCdMs } = await getFishingResolve(client, userId, guildId, member, { profile, gc });
  return {
    atk: atkFromProfile(profile),
    luckBonus: m.luckBonus + guildLuck,
    qtyBonus: m.qtyBonus + guildQty,
    miningCdMs: m.actualCdMs,
    fishingCdMs,
    income: {
      twitch: getCoinTwitchSubBonus(member, "mining_sell"),
      serverBoost: getCoinServerBoostBonus(member, "mining_sell"),
      coinBoost: coinBuff,
    },
    xpBoost: xpBuff,
    farmYieldBonus: getFoodFarmYieldBonus(profile),
    events: eventEngine.getActiveEvents().map((e) => ({
      id: e.id,
      name: e.name,
      luck: Number(e.effects?.miningLuckBonus) || 0,
      qty: Number(e.effects?.miningQtyBonus) || 0,
    })),
    worldEvents: worldEventBuffs.getCachedList().map((e) => {
      const { worldEvents } = require("../../config");
      const cfg = worldEvents?.events?.find((c) => c.id === e.event_id);
      return { event_id: e.event_id, label: cfg?.label, ends_at: e.ends_at, buffs: e.buffs };
    }),
    guildClub: gc.club
      ? {
          id: gc.club.guild_club_id,
          name: gc.club.name,
          level: gc.level,
          buffs: gc.buffs,
          miningLuckBonus: guildLuck,
          miningQtyBonus: guildQty,
          workIncomeBonus: guildWork,
          dungeonStaminaMax: guildStaminaMax,
          bossAtkBonus: guildBossAtk,
          bossAttackLimitBonus: guildBossAttackLimitBonus,
          miningCooldownPct: guildMiningCdPct,
          fishingCooldownPct: guildFishingCdPct,
          dungeonDamagePct: guildDungeonDmgPct,
          critRatePct: guildCritPct,
          bossDamagePct: guildBossDmgPct,
          farmGrowthReductionPct: guildFarmGrowthCutPct,
          harvestCoinPct: guildHarvestCoinPct,
          cookingCritPct: guildCookingCritPct,
          farmLowTierExtraCount: guildFarmLowTierExtra,
          weaponMaxDurabilityPct: guildWeaponMaxDurPct,
          equipmentRepairDiscountPct: guildRepairDiscountPct,
          combatDurabilitySavePct: guildCombatDurSavePct,
          warehouseCapacityBonus: guildWhBonus,
          activeBanquet: gc.activeBanquet || null,
        }
      : null,
  };
}

// ── 依身分組彙整加成（/背包 用：列出各身分組目前提供的 buff）─────────
// 取 member 持有的「最高」Twitch 訂閱身分組對應的 XP 倍率設定。
function xpTwitchSubMultiplier(member) {
  const cfg = levelSystem?.twitchSubBonus;
  if (!cfg?.enabled || !member?.roles?.cache) return { multiplier: 1, name: null };
  let best = null;
  for (const t of cfg.tiers || []) {
    if (!t?.roleId || !(t.multiplier > 1)) continue;
    if (!member.roles.cache.has(t.roleId)) continue;
    if (!best || t.multiplier > best.multiplier) best = t;
  }
  return best
    ? { multiplier: best.multiplier, name: best.name }
    : { multiplier: 1, name: null };
}

function xpServerBoostMultiplier(member) {
  const cfg = levelSystem?.serverBoostBonus;
  if (!cfg?.enabled || !(cfg.multiplier > 1) || !cfg.roleId) {
    return { multiplier: 1, name: null };
  }
  if (!member?.roles?.cache?.has(cfg.roleId)) return { multiplier: 1, name: null };
  return { multiplier: cfg.multiplier, name: cfg.name || "伺服器加成" };
}

// 回傳 [{ header, lines: [] }]，列出此成員目前因「身分組」吃到的加成。
// 沒有任何身分組加成則回 []。涵蓋：Twitch 訂閱、伺服器加成（Booster）、贊助。
async function roleBuffSummary(client, userId, guildId, member) {
  if (!member?.roles?.cache) return [];
  const groups = [];

  // ── Twitch 訂閱（不帶 source → 不套 appliesTo 過濾，取身分組本身的倍率）──
  const perks = twitchPerks.resolvePerks(member);
  const twCoin = getCoinTwitchSubBonus(member);
  const twXp = xpTwitchSubMultiplier(member);
  if (perks || twCoin.multiplier > 1 || twXp.multiplier > 1) {
    const tierLabel =
      twCoin.name ||
      twXp.name ||
      { tier1: "Tier 1", tier2: "Tier 2", tier3: "Tier 3" }[perks?.tierKey] ||
      "訂閱者";
    const lines = [];
    if (twXp.multiplier > 1) lines.push(`📈 經驗 ×${twXp.multiplier}`);
    if (twCoin.multiplier > 1) lines.push(`${MONEY_EMOJI} 金幣 ×${twCoin.multiplier}`);
    if (perks?.miningLuckBonus > 0)
      lines.push(`🍀 挖礦幸運 +${Math.round(perks.miningLuckBonus * 100)}%`);
    if (perks?.miningCdReductionMs > 0)
      lines.push(`⏱️ 挖礦冷卻 -${Math.round(perks.miningCdReductionMs / 60000)} 分`);
    if (perks?.fishingCdReductionMs > 0)
      lines.push(`🎣 釣魚冷卻 -${Math.round(perks.fishingCdReductionMs / 60000)} 分`);
    if (lines.length) groups.push({ header: `💜 Twitch 訂閱（${tierLabel}）`, lines });
  }

  // ── 伺服器加成（Booster）──
  const sbCoin = getCoinServerBoostBonus(member);
  const sbXp = xpServerBoostMultiplier(member);
  if (sbCoin.multiplier > 1 || sbXp.multiplier > 1) {
    const lines = [];
    if (sbXp.multiplier > 1) lines.push(`📈 經驗 ×${sbXp.multiplier}`);
    if (sbCoin.multiplier > 1) lines.push(`${MONEY_EMOJI} 金幣 ×${sbCoin.multiplier}`);
    groups.push({ header: `🚀 ${sbCoin.name || sbXp.name || "伺服器加成"}`, lines });
  }

  // ── 贊助（Donor / VIP Donor）──
  const donorRoleId = donation?.roleIds?.donor;
  const vipRoleId = donation?.roleIds?.vipDonor;
  const hasDonor = donorRoleId && member.roles.cache.has(donorRoleId);
  const hasVip = vipRoleId && member.roles.cache.has(vipRoleId);
  if (hasDonor || hasVip) {
    let luck = 0;
    let exp = 0;
    try {
      if (client.miningProfilesCollection) {
        const profile = await getOrCreate(client, userId, guildId);
        exp = profile?.donation_luck_expires_at
          ? new Date(profile.donation_luck_expires_at).getTime()
          : 0;
        if (exp > Date.now()) luck = profile.donation_luck_bonus || 0;
      }
    } catch {
      /* 讀不到 profile 就只顯示身分組本身 */
    }
    const lines =
      luck > 0
        ? [`🍀 挖礦幸運 +${Math.round(luck * 100)}%（<t:${Math.floor(exp / 1000)}:R>）`]
        : [];
    const donationCdMs = donationFishingCdMs(member);
    if (donationCdMs > 0)
      lines.push(`🎣 釣魚冷卻 -${Math.round(donationCdMs / 60000)} 分`);
    if (lines.length === 0) lines.push("・專屬身分組與外觀");
    groups.push({ header: `💖 ${hasVip ? "VIP 贊助者" : "贊助者"}`, lines });
  }

  return groups;
}

module.exports = {
  atkFromProfile,
  getEffectiveAtk,
  getMiningResolve,
  getFishingResolve,
  getEffectiveLuck,
  getEffectiveCdMs,
  getEffectiveIncomeMultiplier,
  getGuildClubBuffs,
  summary,
  roleBuffSummary,
};
