require("colors");
const { mining, dungeon, shop, guildClub } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const grantCoins = require("../economy/grantCoins");
const grantActivityXp = require("../leveling/grantActivityXp");
const twitchPerks = require("./twitchPerks");
const encounterService = require("./encounterService");
const { getFoodAtkBonus, formatFoodBuffLines } = require("../fishing/cookService");
const { effectiveMaxOf } = require("./equipDurability");
const { warnThresholds } = require("../dungeon/equipDurabilityView");
const bus = require("../eventBus");

// 公會鐵匠鋪 Lv.5：戰鬥扣武器/盾耐久時，每次有機率不消耗。
function rollDurabilitySave(savePct) {
  if (!savePct || savePct <= 0) return false;
  return Math.random() < savePct / 100;
}


function randInt(min, max) {
  const lo = Math.ceil(min ?? 0);
  const hi = Math.floor(max ?? lo);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function rollLoot(profile, legendaryDropPct = 0) {
  const table = dungeon?.loot || [];
  const clears = profile?.dungeon_count || 0;
  const weights = {};
  for (const l of table) {
    // 戰利品可設 minDungeonClears 門檻（例如黑玫瑰種子需 30 場通關）
    if (l.minDungeonClears && clears < l.minDungeonClears) continue;
    let w = l.weight;
    // 世界事件「遠征軍備戰」buff：提升傳說碎片相對權重
    if ((l.kind === "fragment" || l.id === "legendary_fragment") && legendaryDropPct > 0) {
      w = w * (1 + legendaryDropPct / 100);
    }
    weights[l.id] = w;
  }
  const id = weightedRandom(weights);
  return table.find((l) => l.id === id) || { id: "nothing", kind: "nothing" };
}

function staminaBonus(member) {
  return twitchPerks.resolvePerks(member)?.staminaBonus || 0;
}

// 讀取玩家所屬公會的 doc；無公會或 collection 未掛載皆回 null（不報錯）。
async function getMemberClub(client, userId, guildId) {
  if (!guildClub?.enabled) return null;
  if (!client?.guildClubMembersCollection || !client?.guildsClubCollection) return null;
  const m = await client.guildClubMembersCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!m) return null;
  return client.guildsClubCollection
    .findOne({ guild_club_id: m.guild_club_id, disbanded_at: null })
    .catch(() => null);
}

// 公會等級提供的 dungeon_stamina_max 加成總和。
function staminaGuildBonus(club) {
  if (!club) return 0;
  const def = (guildClub?.levels || []).find((l) => l.level === club.level);
  return (def?.buffs || [])
    .filter((b) => b.type === "dungeon_stamina_max")
    .reduce((s, b) => s + (b.value || 0), 0);
}

// 公會建築（訓練場）+ 世界事件 的整數百分比加成。
function clubBuildingPct(club, type) {
  if (!club) return 0;
  const buildingService = require("../guild_club/buildingService");
  const buffs = buildingService.buildingsBuffs(club);
  return buffs[type] || 0;
}
function worldEventPct(type) {
  const worldEventBuffs = require("../world_event/worldEventBuffs");
  return worldEventBuffs.getCachedBuffs()[type] || 0;
}

function staminaMax(member, club = null) {
  const base = dungeon?.staminaMax ?? 10;
  // 世界事件「聖光降臨」等事件可給 dungeon_stamina_max
  const worldEventBuffs = require("../world_event/worldEventBuffs");
  const worldStamina = worldEventBuffs.getCachedBuffs().dungeon_stamina_max || 0;
  return base + staminaBonus(member) + staminaGuildBonus(club) + worldStamina;
}

// 惰性回復：依離線時間補體力。回傳 { stamina, updatedAt, nextRegenAt }。
// 滿體力時 updatedAt 視為 0（計時器停擺），nextRegenAt = null。
function resolveStamina(profile, max = staminaMax()) {
  const regenMs = dungeon?.staminaRegenMs ?? 3600000;
  let stamina = typeof profile?.stamina === "number" ? profile.stamina : max;
  let updatedAt = profile?.stamina_updated_at || 0;

  if (stamina >= max) {
    return { stamina: max, updatedAt: 0, nextRegenAt: null };
  }

  const now = Date.now();
  if (!updatedAt) updatedAt = now;
  const regened = Math.floor((now - updatedAt) / regenMs);
  if (regened > 0) {
    stamina = Math.min(max, stamina + regened);
    updatedAt = updatedAt + regened * regenMs;
  }

  if (stamina >= max) {
    return { stamina: max, updatedAt: 0, nextRegenAt: null };
  }
  return { stamina, updatedAt, nextRegenAt: updatedAt + regenMs };
}

// 立即恢復體力（體力藥水用）。回傳恢復前後數值；已滿時 full=true 不寫庫。
async function restoreStamina(client, { userId, guildId, member, amount }) {
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const profile = await getOrCreate(client, userId, guildId);
  const st = resolveStamina(profile, max);

  if (st.stamina >= max) {
    return { ok: true, full: true, restored: 0, staminaBefore: st.stamina, staminaAfter: st.stamina, max };
  }

  const add = Math.max(0, Math.floor(Number(amount) || 0));
  const newStamina = Math.min(max, st.stamina + add);
  // 還沒補滿就沿用原本的回復計時；補滿則停錶（updatedAt = 0）。
  const newUpdatedAt = newStamina >= max ? 0 : st.updatedAt || Date.now();

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $set: { stamina: newStamina, stamina_updated_at: newUpdatedAt, updatedAt: new Date() } },
  );

  return {
    ok: true,
    full: false,
    restored: newStamina - st.stamina,
    staminaBefore: st.stamina,
    staminaAfter: newStamina,
    max,
    nextRegenAt: resolveStamina(
      { stamina: newStamina, stamina_updated_at: newUpdatedAt },
      max,
    ).nextRegenAt,
  };
}

// 體力藥水分級：小 / 中 / 大，各自對應 shop type 與 profile 欄位。
const STAMINA_POTION_TIERS = {
  small:  { field: "stamina_potion_count",        type: "mining_stamina_potion",        name: "體力藥水（小）" },
  medium: { field: "stamina_potion_medium_count", type: "mining_stamina_potion_medium", name: "體力藥水（中）" },
  large:  { field: "stamina_potion_large_count",  type: "mining_stamina_potion_large",  name: "體力藥水（大）" },
};
const STAMINA_TIER_BY_SIZE_DESC = ["large", "medium", "small"];

function staminaPotionRestore(tier) {
  const meta = STAMINA_POTION_TIERS[tier];
  const item = (shop?.items || []).find((i) => i.type === meta?.type);
  return item?.payload?.restore || 0;
}

function totalStaminaPotions(profile) {
  return Object.values(STAMINA_POTION_TIERS).reduce(
    (s, m) => s + (profile?.[m.field] || 0),
    0,
  );
}

// 未指定 tier 時（緊急快捷補體力），優先用持有中「最大」的那瓶。
function bestStaminaTier(profile) {
  for (const t of STAMINA_TIER_BY_SIZE_DESC) {
    if ((profile?.[STAMINA_POTION_TIERS[t].field] || 0) > 0) return t;
  }
  return null;
}

// 使用一瓶體力藥水：扣 1 罐 + 補體力。庫存或體力滿時各自回傳對應 reason。
// tier 可選（small/medium/large）；未指定則用持有中最大的一瓶。
async function useStaminaPotion(client, { userId, guildId, member, tier }) {
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const profile = await getOrCreate(client, userId, guildId);

  const useTier = STAMINA_POTION_TIERS[tier] ? tier : bestStaminaTier(profile);
  if (!useTier) return { ok: false, reason: "no_potion" };
  const meta = STAMINA_POTION_TIERS[useTier];

  if ((profile[meta.field] || 0) <= 0) return { ok: false, reason: "no_potion" };

  const st = resolveStamina(profile, max);
  if (st.stamina >= max) {
    return { ok: false, reason: "full", staminaBefore: st.stamina, max };
  }

  const restore = staminaPotionRestore(useTier) || 5;

  // 原子扣減：filter 帶對應欄位 >= 1，防止連點重複扣
  const updated = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId, [meta.field]: { $gte: 1 } },
    { $inc: { [meta.field]: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const updatedDoc = updated?.value || updated;
  if (!updatedDoc) return { ok: false, reason: "retry" };

  const restored = await restoreStamina(client, { userId, guildId, member, amount: restore });
  return {
    ok: true,
    tier: useTier,
    tierName: meta.name,
    staminaBefore: restored.staminaBefore,
    staminaAfter: restored.staminaAfter,
    restored: restored.restored,
    max: restored.max,
    potionLeft: updatedDoc[meta.field] || 0,
    totalPotionLeft: totalStaminaPotions(updatedDoc),
    nextRegenAt: restored.nextRegenAt,
  };
}

// 自動喝體力藥水：依偏好挑一瓶（回傳 tier 或 null）。
// 偏好同生命藥水設定：smallest / largest / small / medium / large。
function pickAutoStaminaTier(profile, tierPref = "smallest") {
  const has = (t) => (profile?.[STAMINA_POTION_TIERS[t].field] || 0) > 0;
  if (["small", "medium", "large"].includes(tierPref)) {
    return has(tierPref) ? tierPref : null;
  }
  const order = tierPref === "largest"
    ? ["large", "medium", "small"]
    : ["small", "medium", "large"];
  return order.find(has) || null;
}

// 進場前體力不足時自動補：連續喝體力藥水直到夠進場（或喝光 / 補滿）。
// 回傳喝掉的瓶數與明細，交給呼叫端顯示。
async function autoDrinkStaminaFor(client, { userId, guildId, member, needed, tierPref }) {
  const tiers = [];
  for (let i = 0; i < 12; i += 1) {
    const club = await getMemberClub(client, userId, guildId);
    const max = staminaMax(member, club);
    const profile = await getOrCreate(client, userId, guildId);
    if (resolveStamina(profile, max).stamina >= needed) break;
    const tier = pickAutoStaminaTier(profile, tierPref);
    if (!tier) break;
    const r = await useStaminaPotion(client, { userId, guildId, member, tier });
    if (!r.ok) break;
    tiers.push(tier);
    if (r.staminaAfter >= r.max) break;
  }
  return { drank: tiers.length, tiers };
}

// 估算「體力補滿」的 epoch ms。已滿回 0；用於到點通知與 /通知設定 面板。
// member 可選，用於把 Twitch 訂閱的體力上限加乘算進去。
async function staminaFullAt(client, { userId, guildId, member }) {
  if (!client?.miningProfilesCollection) return 0;
  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const profile = await client.miningProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!profile) return 0;
  const st = resolveStamina(profile, max);
  if (st.stamina >= max) return 0;
  const regenMs = dungeon?.staminaRegenMs ?? 3600000;
  const baseAt = st.updatedAt || Date.now();
  return baseAt + (max - st.stamina) * regenMs;
}

// 戰鬥力 = baseAtk + 武器 ATK + 食物 buff（鎬子不再貢獻戰鬥力，純採集）。
function playerAtk(profile) {
  const base = dungeon?.baseAtk ?? 20;
  const weapons = dungeon?.weapons || {};
  const wdef = weapons[profile?.weapon] || weapons.fist || {};
  const weaponAtk = base + (wdef.atk || 0);
  return weaponAtk + getFoodAtkBonus(profile, weaponAtk);
}

// 是否持有可用武器（非赤手）。打怪硬門檻：必須先打造劍。
function hasWeapon(profile) {
  return !!profile?.weapon && profile.weapon !== "fist";
}

function rollMonster() {
  const list = dungeon?.monsters || [];
  const m = list.length
    ? list[Math.floor(Math.random() * list.length)]
    : { name: "地穴怪物", emoji: "👾" };
  const hpMin = dungeon?.monsterHpMin ?? 50;
  const hpMax = dungeon?.monsterHpMax ?? 200;
  const hp = Math.floor(Math.random() * (hpMax - hpMin + 1)) + hpMin;
  return { ...m, hp };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// 進地下城戰鬥一次。回傳結果交由指令層呈現。
async function enterDungeon(client, { userId, guildId, member, username, allowOverflow = false }) {
  if (!dungeon?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const bonus = staminaBonus(member);
  const profile = await getOrCreate(client, userId, guildId);

  const st = resolveStamina(profile, max);

  if (st.stamina <= 0) {
    return {
      ok: false,
      reason: "no_stamina",
      nextRegenAt: st.nextRegenAt,
      max,
      staminaBonus: bonus,
      potionCount: totalStaminaPotions(profile),
    };
  }

  // 背包完全滿 → 先讓玩家確認（戰利品掉到礦的話會直接折金幣，不會佔背包）
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap && !allowOverflow) {
    return { ok: false, reason: "backpack_full", used, cap };
  }

  // 消耗 1 點體力；若原本是滿的，從現在開始起算回復計時。
  const now = Date.now();
  const wasFull = st.stamina >= max;
  const newStamina = st.stamina - 1;
  const newUpdatedAt = wasFull ? now : st.updatedAt;

  const monster = rollMonster();
  // 訓練場 + 世界事件 dungeon_damage_pct 把 atk 拉高（兩者皆是「百分比加成」）；
  // 亡靈制（斷劍王詛咒）反過來扣 dungeon ATK%（compute-on-read，過期即失效）。
  const dmgPct =
    clubBuildingPct(club, "dungeon_damage_pct") +
    worldEventPct("dungeon_damage_pct") -
    swordBreakService.undeadAtkPenaltyPct(profile);
  const baseAtk = playerAtk(profile);
  const atk = Math.max(1, Math.floor(baseAtk * (100 + dmgPct) / 100));
  // 赤手空拳也能打，但勝率極低（套較低的天花板、且不吃 winRateMin 保底）；
  // 有武器才適用一般的 winRateMin ~ winRateMax 區間。
  const usingFist = !hasWeapon(profile);
  const winRate = usingFist
    ? clamp(atk / monster.hp, 0, dungeon?.fistWinRateMax ?? 0.1)
    : clamp(
        atk / monster.hp,
        dungeon?.winRateMin ?? 0.2,
        dungeon?.winRateMax ?? 0.9
      );
  const weapons = dungeon?.weapons || {};
  const wdef = weapons[profile.weapon] || {};
  // 訓練場 crit_rate_pct：整數百分比，疊加在武器 critRate（小數 0.1）之上
  const baseCritRate = wdef.critRate || 0;
  const critPct = clubBuildingPct(club, "crit_rate_pct");
  const critRate = baseCritRate + (critPct / 100);
  const crit = Math.random() < critRate; // 暴擊保證命中要害 → 直接獲勝
  const won = Math.random() < winRate || crit;

  const set = {
    stamina: newStamina,
    stamina_updated_at: newUpdatedAt,
    updatedAt: new Date(),
  };
  const inc = { dungeon_count: 1 };

  // 武器耐久：打怪時消耗（與鎬子挖礦時消耗同模式）；歸 0 退回赤手。
  let weaponBroke = false;
  let weaponDurabilityAfter = null;
  let weaponDurabilityWarnCrossed = null;
  const weaponBefore = profile.weapon;
  const hasWeaponDurability =
    profile.weapon !== "fist" && typeof profile.weapon_durability === "number";
  if (hasWeaponDurability) {
    const before = profile.weapon_durability;
    // 亡靈制詛咒：每場多扣武器耐久，讓兵刃更快崩壞。
    const durCost = 1 + swordBreakService.undeadExtraDurabilityCost(profile);
    const saved = rollDurabilitySave(
      clubBuildingPct(club, "combat_durability_save_pct")
    );
    if (saved) {
      weaponDurabilityAfter = before;
    } else {
      weaponDurabilityAfter = before - durCost;
      if (weaponDurabilityAfter <= 0) {
        weaponBroke = true;
        weaponDurabilityAfter = null;
        set.weapon = "fist";
        set.weapon_durability = null;
      } else {
        inc.weapon_durability = -durCost;
        const th = warnThresholds(durCost);
        if (before > th.critical && weaponDurabilityAfter <= th.critical) {
          weaponDurabilityWarnCrossed = "critical";
        } else if (before > th.low && weaponDurabilityAfter <= th.low) {
          weaponDurabilityWarnCrossed = "low";
        }
      }
    }
  }

  // 戰利品（僅勝利時）
  let loot = { id: "nothing", kind: "nothing" };
  let coinsGained = 0;
  let oreGained = null; // { ore, qty }
  let oreOverflowToCoins = false;
  let legendaryGained = 0;
  let potionGained = 0;
  let ticketGained = 0;
  let slimeGained = 0;
  let seedGained = null; // { seedKey, qty }

  if (won) {
    const legendaryDropPct = worldEventPct("dungeon_legendary_drop_pct");
    loot = rollLoot(profile, legendaryDropPct);
    const kind = loot.kind || loot.id;

    if (kind === "ore" || loot.id === "ore_fragment") {
      const oreKey = loot.ore || "iron";
      const qty = loot.qty || 1;
      const cap = backpackCapacity(profile, mining);
      const used = backpackUsed(profile);
      const space = Math.max(0, cap - used);
      if (space >= qty) {
        inc[`backpack.${oreKey}`] = (inc[`backpack.${oreKey}`] || 0) + qty;
        inc[`lifetime_ore.${oreKey}`] = (inc[`lifetime_ore.${oreKey}`] || 0) + qty;
        oreGained = { ore: oreKey, qty };
      } else {
        // 背包滿了就折算成等值金幣，避免戰利品憑空消失
        const price = mining?.ores?.[oreKey]?.price || 0;
        coinsGained += price * qty;
        oreOverflowToCoins = true;
        oreGained = { ore: oreKey, qty };
      }
    } else if (kind === "coins") {
      const lo = loot.minCoins ?? 150;
      const hi = loot.maxCoins ?? 300;
      coinsGained += randInt(lo, hi);
    } else if (kind === "fragment" || loot.id === "legendary_fragment") {
      legendaryGained = loot.qty || 1;
      inc.legendary_fragments = (inc.legendary_fragments || 0) + legendaryGained;
    } else if (kind === "luck_potion") {
      potionGained = loot.qty || 1;
      inc.luck_potion_uses = (inc.luck_potion_uses || 0) + potionGained;
    } else if (kind === "cd_ticket") {
      ticketGained = loot.qty || 1;
      inc.cd_ticket_count = (inc.cd_ticket_count || 0) + ticketGained;
    } else if (kind === "slime") {
      slimeGained = loot.qty || 1;
      inc["backpack.monster_slime"] = (inc["backpack.monster_slime"] || 0) + slimeGained;
    } else if (kind === "seed") {
      const seedKey = loot.seedKey;
      const qty = loot.qty || 1;
      if (seedKey) {
        seedGained = { seedKey, qty };
        inc[`seed_bag.${seedKey}`] = (inc[`seed_bag.${seedKey}`] || 0) + qty;
      }
    }

    // 暴擊額外獎勵：金幣類戰利品 ×1.5
    if (crit && coinsGained > 0) {
      coinsGained = Math.round(coinsGained * 1.5);
    }
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set }
  );

  let balance = null;
  let coinsGrantedTotal = coinsGained;
  if (coinsGained > 0) {
    const grant = await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: coinsGained,
      source: "dungeon",
      member,
      meta: { monster: monster.name, overflow: oreOverflowToCoins || undefined },
    });
    balance = grant?.doc?.totalCoins ?? null;
    if (grant?.granted) coinsGrantedTotal = grant.granted;
  }

  const result = {
    ok: true,
    won,
    crit,
    usingFist,
    monster,
    atk,
    winRate,
    loot,
    coinsGained: coinsGrantedTotal,
    coinsBase: coinsGained,
    oreGained,
    oreOverflowToCoins,
    legendaryGained,
    potionGained,
    ticketGained,
    slimeGained,
    seedGained,
    balance,
    stamina: newStamina,
    staminaMax: max,
    staminaBonus: bonus,
    staminaNextRegenAt: resolveStamina(
      { stamina: newStamina, stamina_updated_at: newUpdatedAt },
      max
    ).nextRegenAt,
    dungeonCount: (profile.dungeon_count || 0) + 1,
    weaponBefore,
    weaponBroke,
    weaponDurabilityAfter,
    weaponDurabilityWarnCrossed,
    legendarySwordBroke: weaponBroke && swordBreakService.isTrackedSword(weaponBefore),
    foodBuffLines: formatFoodBuffLines(profile, "dungeon"),
  };

  // 傳說級以上的劍斷裂：記錄斷劍榜 + 公開播報（fire-and-forget，自帶錯誤吞掉）
  if (result.legendarySwordBroke) {
    swordBreakService
      .handleLegendaryBreak(client, { userId, guildId, weapon: weaponBefore })
      .catch(() => {});
  }

  // 世界事件觸發 roll（僅勝利時觸發）：fire-and-forget
  if (won) {
    require("../world_event/worldEventService")
      .rollTrigger(client, "dungeon_clear", {})
      .catch(() => {});
  }

  bus.emit("dungeon.cleared", {
    userId,
    guildId,
    won,
    monster: monster.name,
    dungeonCount: result.dungeonCount,
  });
  if (won) {
    if (oreGained?.qty > 0 && !oreOverflowToCoins) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "ore",
        itemId: oreGained.ore,
        qty: oreGained.qty,
        source: "dungeon",
      });
    }
    if (legendaryGained > 0) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "fragment",
        itemId: "legendary_fragment",
        qty: legendaryGained,
        source: "dungeon",
      });
    }
    if (potionGained > 0) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "potion",
        itemId: "luck_potion",
        qty: potionGained,
        source: "dungeon",
      });
    }
    if (ticketGained > 0) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "ticket",
        itemId: "cd_ticket",
        qty: ticketGained,
        source: "dungeon",
      });
    }
    if (slimeGained > 0) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "monster_drop",
        itemId: "monster_slime",
        qty: slimeGained,
        source: "dungeon",
      });
    }
    if (seedGained?.qty > 0) {
      bus.emit("item.gained", {
        userId, guildId,
        itemType: "seed",
        itemId: seedGained.seedKey,
        qty: seedGained.qty,
        source: "dungeon",
      });
    }
  }

  // 突發事件（戰鬥擴充）：戰後以一定機率觸發。會自行寫庫並可能改動體力。
  const enc = await encounterService
    .trigger(client, {
      context: "dungeon",
      userId,
      guildId,
      member,
      username,
      baseResult: result,
    })
    .catch(() => null);
  if (enc) {
    if (typeof enc.patch?.staminaAfter === "number") {
      result.stamina = enc.patch.staminaAfter;
    }
    result.encounter = { name: enc.name, emoji: enc.emoji, body: enc.body, loot: enc.loot || [], outcome: enc.outcome || null };
    if (enc.diamondGained > 0) result.encounterDiamond = enc.diamondGained;
  }

  result.xpGained = await grantActivityXp(client, "dungeon", {
    userId,
    guildId,
    username,
    member,
    meta: { won },
  });

  return result;
}

// 失敗時回滾：把 enterDungeon 寫入的體力、武器耐久、戰利品、金幣全部退回。
// 用於 /地下城 指令在 enterDungeon 之後出錯（rendering / editReply 等），
// 讓玩家不會白白損失資源。突發事件的副作用不在這裡處理（範圍小且為盡力而為）。
async function rollbackDungeon(client, { userId, guildId, username, member }, result) {
  if (!result?.ok) return;
  if (!client?.miningProfilesCollection) return;

  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const inc = {};
  const set = { updatedAt: new Date() };

  inc.dungeon_count = -1;

  if (result.weaponBroke) {
    set.weapon = result.weaponBefore;
    set.weapon_durability = 1;
  } else if (typeof result.weaponDurabilityAfter === "number") {
    inc.weapon_durability = 1;
  }

  if (result.oreGained && !result.oreOverflowToCoins) {
    inc[`backpack.${result.oreGained.ore}`] = -result.oreGained.qty;
    inc[`lifetime_ore.${result.oreGained.ore}`] = -result.oreGained.qty;
  }
  if (result.legendaryGained > 0) inc.legendary_fragments = -result.legendaryGained;
  if (result.potionGained > 0) inc.luck_potion_uses = -result.potionGained;
  if (result.ticketGained > 0) inc.cd_ticket_count = -result.ticketGained;
  if (result.slimeGained > 0) inc["backpack.monster_slime"] = -result.slimeGained;
  if (result.seedGained?.qty > 0) {
    inc[`seed_bag.${result.seedGained.seedKey}`] = -result.seedGained.qty;
  }

  // 體力 +1（夾在 max）。讀當前再寫，避免突發事件改過後的競態。
  const cur = await client.miningProfilesCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  const curStamina = typeof cur?.stamina === "number" ? cur.stamina : max;
  const refunded = Math.min(max, curStamina + 1);
  set.stamina = refunded;
  if (refunded >= max) set.stamina_updated_at = 0;

  await client.miningProfilesCollection
    .updateOne({ userId, guildId }, { $inc: inc, $set: set })
    .catch((e) => console.log(`[ERROR] rollbackDungeon profile: ${e}`.red));

  if (result.coinsGained > 0) {
    await grantCoins(client, {
      userId,
      guildId,
      username,
      amount: -result.coinsGained,
      source: "admin",
      member,
      meta: { reason: "dungeon_rollback", monster: result.monster?.name },
    }).catch((e) => console.log(`[ERROR] rollbackDungeon coins: ${e}`.red));
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Phase H+：HP 多回合戰鬥入口（與既有 enterDungeon 並存，玩家用 subcommand 選擇）。
// ────────────────────────────────────────────────────────────────────────────

const battleEngine = require("../dungeon/battleEngine");
const floorService = require("../dungeon/floorService");
const hpService = require("../dungeon/hpService");
const swordBreakService = require("../dungeon/swordBreakService");
const { getFoodDefBonus, getFoodHpMaxBonus } = require("../fishing/cookService");
const { ObjectId } = require("mongodb");

function pickMonsterForFloor(theme, floor) {
  const f = (dungeon?.floors || []).find((x) => x.floor === floor);
  if (!f) return null;
  // 主題影響怪物池：themeMonsterOverrides[theme][floor] 優先，沒設定 fallback 到 floor.monsterPool
  const overrides = dungeon?.themeMonsterOverrides?.[theme];
  const pool = (overrides && overrides[String(floor)]) || f.monsterPool || [];
  const id = pool[Math.floor(Math.random() * pool.length)];
  const def = dungeon?.monsterDefs?.[id];
  if (!def) return { id, name: id, emoji: "👾" };
  const hp = randInt(f.monsterHpRange?.[0] || 100, f.monsterHpRange?.[1] || 200);
  const atk = randInt(f.monsterAtkRange?.[0] || 10, f.monsterAtkRange?.[1] || 15);
  return { id, name: def.name, emoji: def.emoji, hp, atk, skills: def.skills || [], def: 0 };
}

async function getPlayerLevel(client, userId, guildId) {
  if (!client?.userLevelsCollection) return 0;
  const doc = await client.userLevelsCollection
    .findOne({ userId, guildId })
    .catch(() => null);
  if (!doc) return 0;
  if (typeof doc.level === "number") return doc.level;
  try {
    const { getLevelProgress } = require("../../utils/levelMath");
    return getLevelProgress(doc.totalXp || 0).level || 0;
  } catch {
    return 0;
  }
}

// 玩家有效血量上限：base + 等級 + 食物 / 公會 / 世界事件 dungeon_hp_max buff。
// 地下城面板、實戰、決鬥三邊都走這支，確保數值一致；帶入已取好的 profile/club/level 可省查詢。
async function effectiveHpMax(client, { userId, guildId, profile, club, level } = {}) {
  const lv = typeof level === "number" ? level : await getPlayerLevel(client, userId, guildId);
  const p = profile || (await getOrCreate(client, userId, guildId));
  const cl = club !== undefined ? club : await getMemberClub(client, userId, guildId);
  return (
    hpService.hpMax(lv, {
      food: getFoodHpMaxBonus(p),
      guild: clubBuildingPct(cl, "dungeon_hp_max"),
      pet: 0,
    }) + (worldEventPct("dungeon_hp_max") || 0)
  );
}

// 進入 HP 多回合戰鬥。回傳給呼叫端（指令層）一份完整結果，含戰鬥日誌。
// 體力 / 武器耐久 / 盾耐久 / HP / 戰利品 / DB 寫入 / event / quest 一次處理完。
async function enterDungeonHp(client, {
  userId, guildId, member, username,
  themeId = "mine", floor = 1,
  isMiniBoss = false,
  allowOverflow = false,
}) {
  if (!dungeon?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const club = await getMemberClub(client, userId, guildId);
  const staMaxV = staminaMax(member, club);
  const level = await getPlayerLevel(client, userId, guildId);
  let profile = await getOrCreate(client, userId, guildId);

  // mini-BOSS 路徑：解鎖檢查走 floorService.miniBossUnlockState；非樓層解鎖。
  let miniBossDef = null;
  let f;
  if (isMiniBoss) {
    const mbState = floorService.miniBossUnlockState(profile, level, themeId);
    if (!mbState.unlocked) {
      return { ok: false, reason: "mini_boss_locked", miniBossState: mbState, level };
    }
    miniBossDef = mbState.miniBoss;
    // 體力 / 武器耐久消耗依 mini-BOSS def，無 prereqClears 更新
    f = {
      floor: 5,
      name: miniBossDef.name,
      emoji: miniBossDef.emoji || "👹",
      staminaCost: miniBossDef.staminaCost || 3,
      weaponDurabilityCost: miniBossDef.weaponDurabilityCost || 4,
      rewardMultiplier: 4.0,
      clearReward: miniBossDef.clearReward || 0,
      encounterRatePct: 0, // mini-BOSS 不觸發隨機事件，避免戲劇性失焦
      monsterPool: [],
    };
  } else {
    // 1) 解鎖檢查（樓層、主題）— 失敗回完整原因供 UX 顯示
    const floorState = floorService.floorUnlockState(profile, level, themeId, floor);
    if (!floorState.unlocked) {
      return { ok: false, reason: "floor_locked", floorState, level };
    }
    f = floorState.floor;
  }

  // 2) 體力檢查（不足時，若玩家開了「自動喝體力藥水」就先自動補到夠再進場）
  const staCost = f.staminaCost || 1;
  let st = resolveStamina(profile, staMaxV);
  let autoStamina = null;
  if (
    st.stamina < staCost &&
    profile.dungeon_auto_stamina === true &&
    totalStaminaPotions(profile) > 0
  ) {
    const drink = await autoDrinkStaminaFor(client, {
      userId, guildId, member,
      needed: staCost,
      tierPref: profile.dungeon_auto_stamina_tier || "smallest",
    });
    if (drink.drank > 0) {
      autoStamina = drink;
      profile = await getOrCreate(client, userId, guildId);
      st = resolveStamina(profile, staMaxV);
    }
  }
  if (st.stamina < staCost) {
    return {
      ok: false,
      reason: "no_stamina",
      nextRegenAt: st.nextRegenAt,
      max: staMaxV,
      staminaBonus: staminaBonus(member),
      potionCount: totalStaminaPotions(profile),
      staCost,
    };
  }

  // 3) 背包檢查（戰利品掉到礦會折金幣，但封頂時還是先警告一次）
  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap && !allowOverflow) {
    return { ok: false, reason: "backpack_full", used, cap };
  }

  // 4) 組玩家戰鬥屬性（食物 + 世界事件 + 公會 buff 全部疊上）
  const hpMaxV = await effectiveHpMax(client, { userId, guildId, profile, club, level });
  const hpSt = hpService.resolveHp(profile, hpMaxV);
  // 亡靈制（斷劍王詛咒）反過來扣 dungeon ATK%（compute-on-read，過期即失效）。
  const dmgPct =
    clubBuildingPct(club, "dungeon_damage_pct") +
    worldEventPct("dungeon_damage_pct") -
    swordBreakService.undeadAtkPenaltyPct(profile);
  const baseAtk = playerAtk(profile);
  const atk = Math.max(1, Math.floor(baseAtk * (100 + dmgPct) / 100));

  const weapons = dungeon?.weapons || {};
  const wdef = weapons[profile.weapon] || weapons.fist || {};
  const shields = dungeon?.shields || {};
  const sdef = shields[profile.shield] || {};

  const critPct = clubBuildingPct(club, "crit_rate_pct");
  const critRate = (wdef.critRate || 0) + (critPct / 100);
  const def =
    (wdef.def || 0) +
    (sdef.def || 0) +
    getFoodDefBonus(profile, (wdef.def || 0) + (sdef.def || 0)) +
    (worldEventPct("dungeon_def") || 0); // 世界事件「鋼鐵防線」

  let monster;
  let miniBossArg = null;
  if (isMiniBoss && miniBossDef) {
    monster = {
      id: miniBossDef.id,
      name: miniBossDef.name,
      emoji: miniBossDef.emoji || "👹",
      hp: miniBossDef.hp,
      atk: miniBossDef.atk,
      skills: [],
      def: 0,
    };
    miniBossArg = {
      phase2HpRatio: miniBossDef.phase2HpRatio,
      phase2AtkMult: miniBossDef.phase2AtkMult,
      armorTurns: miniBossDef.armorTurns,
      paralyzeChance: miniBossDef.paralyzeChance,
    };
  } else {
    monster = pickMonsterForFloor(themeId, floor);
    if (!monster) return { ok: false, reason: "no_monster" };
  }

  // 5) 跑戰鬥引擎
  const battle = battleEngine.simulate({
    player: {
      atk,
      def,
      critRate,
      hp_max: hpMaxV,
      hp_current: hpSt.hp,
      weapon: profile.weapon,
      shield: profile.shield,
      shield_durability: profile.shield_durability || 0,
      combatDurabilitySavePct: clubBuildingPct(club, "combat_durability_save_pct"),
      potions: {
        small: profile.hp_potion_small || 0,
        medium: profile.hp_potion_medium || 0,
        large: profile.hp_potion_large || 0,
      },
      petType: "none", // Phase H 寵物接上後改傳 petResolver.getCombatPetType(...)
      autoPotion: profile.dungeon_auto_potion !== false,
      potionTier: profile.dungeon_auto_potion_tier || "smallest",
    },
    monster,
    miniBoss: miniBossArg,
  });

  const won = battle.result === "win";

  // 6) 武器耐久（按樓層階梯扣，與既有同模式）
  let weaponBroke = false;
  let weaponDurabilityAfter = null;
  let weaponDurabilityWarnCrossed = null;
  const weaponBefore = profile.weapon;
  const wdurCost = f.weaponDurabilityCost || 1;
  const hasWeaponDurability =
    profile.weapon !== "fist" && typeof profile.weapon_durability === "number";

  // 7) 戰利品（僅勝利時，套樓層倍率）
  let loot = { id: "nothing", kind: "nothing" };
  let coinsGained = 0;
  let oreGained = null;
  let oreOverflowToCoins = false;
  let legendaryGained = 0;
  let potionGained = 0;
  let ticketGained = 0;
  let slimeGained = 0;
  let clearRewardCoins = 0;
  // C1：把這兩個變數提到 outer scope（原本 var 在分支裡 hoist，雖能跑但 ESLint 會 warn）
  let floorEvents = [];
  let deathDrop = null;
  let seedGained = null;
  let undeadCurse = null;

  const inc = { dungeon_count: 1 };
  const set = {
    stamina: st.stamina - staCost,
    stamina_updated_at: st.stamina >= staMaxV ? Date.now() : st.updatedAt,
    hp_current: Math.max(0, battle.playerEnd.hp_current),
    hp_updated_at: battle.playerEnd.hp_current >= hpMaxV ? 0 : Date.now(),
    updatedAt: new Date(),
  };

  // 盾耐久：戰鬥中扣的次數已在 battle.playerEnd.shield_durability
  if (profile.shield && typeof profile.shield_durability === "number") {
    set.shield_durability = Math.max(0, battle.playerEnd.shield_durability);
  }

  // 藥水：戰鬥中自動使用的扣量寫回
  if (battle.playerEnd.potions.small !== profile.hp_potion_small) {
    set.hp_potion_small = battle.playerEnd.potions.small;
  }
  if (battle.playerEnd.potions.medium !== profile.hp_potion_medium) {
    set.hp_potion_medium = battle.playerEnd.potions.medium;
  }
  if (battle.playerEnd.potions.large !== profile.hp_potion_large) {
    set.hp_potion_large = battle.playerEnd.potions.large;
  }

  if (hasWeaponDurability) {
    const before = profile.weapon_durability;
    // 亡靈制詛咒：在樓層本身的耐久消耗上再多扣，讓兵刃更快崩壞。
    const effWdurCost = wdurCost + swordBreakService.undeadExtraDurabilityCost(profile);
    const saved = rollDurabilitySave(
      clubBuildingPct(club, "combat_durability_save_pct")
    );
    if (saved) {
      weaponDurabilityAfter = before;
    } else {
      weaponDurabilityAfter = before - effWdurCost;
      if (weaponDurabilityAfter <= 0) {
        weaponBroke = true;
        weaponDurabilityAfter = null;
        set.weapon = "fist";
        set.weapon_durability = null;
      } else {
        inc.weapon_durability = -effWdurCost;
        const th = warnThresholds(effWdurCost);
        if (before > th.critical && weaponDurabilityAfter <= th.critical) {
          weaponDurabilityWarnCrossed = "critical";
        } else if (before > th.low && weaponDurabilityAfter <= th.low) {
          weaponDurabilityWarnCrossed = "low";
        }
      }
    }
  }

  if (won) {
    const legendaryDropPct = worldEventPct("dungeon_legendary_drop_pct");
    loot = rollLoot(profile, legendaryDropPct);
    const kind = loot.kind || loot.id;
    const mult = f.rewardMultiplier || 1;

    if (kind === "ore" || loot.id === "ore_fragment") {
      const oreKey = loot.ore || "iron";
      const qty = Math.max(1, Math.floor((loot.qty || 1) * mult));
      const space = Math.max(0, cap - used);
      if (space >= qty) {
        inc[`backpack.${oreKey}`] = (inc[`backpack.${oreKey}`] || 0) + qty;
        inc[`lifetime_ore.${oreKey}`] = (inc[`lifetime_ore.${oreKey}`] || 0) + qty;
        oreGained = { ore: oreKey, qty };
      } else {
        const price = mining?.ores?.[oreKey]?.price || 0;
        coinsGained += price * qty;
        oreOverflowToCoins = true;
        oreGained = { ore: oreKey, qty };
      }
    } else if (kind === "coins") {
      const lo = loot.minCoins ?? 150;
      const hi = loot.maxCoins ?? 300;
      coinsGained += Math.floor(randInt(lo, hi) * mult);
    } else if (kind === "fragment" || loot.id === "legendary_fragment") {
      legendaryGained = loot.qty || 1;
      inc.legendary_fragments = (inc.legendary_fragments || 0) + legendaryGained;
    } else if (kind === "luck_potion") {
      potionGained = loot.qty || 1;
      inc.luck_potion_uses = (inc.luck_potion_uses || 0) + potionGained;
    } else if (kind === "cd_ticket") {
      ticketGained = loot.qty || 1;
      inc.cd_ticket_count = (inc.cd_ticket_count || 0) + ticketGained;
    } else if (kind === "slime") {
      slimeGained = Math.max(1, Math.floor((loot.qty || 1) * mult));
      inc["backpack.monster_slime"] = (inc["backpack.monster_slime"] || 0) + slimeGained;
    } else if (kind === "seed") {
      const seedKey = loot.seedKey;
      const qty = loot.qty || 1;
      if (seedKey) {
        seedGained = { seedKey, qty };
        inc[`seed_bag.${seedKey}`] = (inc[`seed_bag.${seedKey}`] || 0) + qty;
      }
    }

    // 通關保底金幣：不論戰利品骰到什麼，勝利就給樓層對應的保底金幣。
    // 高樓層保底顯著高於低樓層，讓「付出更多耐久 / 體力」換得對得起的回報。
    if (f.clearReward > 0) {
      clearRewardCoins = f.clearReward;
      coinsGained += clearRewardCoins;
    }

    if (isMiniBoss) {
      // mini-BOSS 必掉 ≥ 1 傳說碎片 + 屠龍累積 + 主題擊殺
      // C3 修正：如果 loot 已經給 1 個碎片就不再額外 +1，否則補到 1（避免雙計）
      if (legendaryGained < 1) {
        const need = 1 - legendaryGained;
        legendaryGained = 1;
        inc.legendary_fragments = (inc.legendary_fragments || 0) + need;
      }
      inc[`mini_boss_kills.${themeId}`] = (inc[`mini_boss_kills.${themeId}`] || 0) + 1;
      inc.dragon_slayer_kills = (inc.dragon_slayer_kills || 0) + 1;
      // floorEvents 已預設 []
    } else {
      // 樓層通關推進
      const upd = floorService.buildClearedUpdate(profile, themeId, floor);
      for (const [k, v] of Object.entries(upd.inc)) {
        inc[k] = (inc[k] || 0) + v;
      }
      Object.assign(set, upd.set);
      floorEvents = upd.events;
    }

    // 亡靈制詛咒「亡靈軍團作祟」：斷劍王勝利時有機率被斷劍怨靈奪走部分戰利品與生命。
    undeadCurse = swordBreakService.rollUndeadCurse(profile);
    if (undeadCurse) {
      if (undeadCurse.coinLoss > 0) coinsGained = Math.max(0, coinsGained - undeadCurse.coinLoss);
      if (undeadCurse.hpLossPct > 0) {
        const drain = Math.floor((hpMaxV * undeadCurse.hpLossPct) / 100);
        if (drain > 0) {
          set.hp_current = Math.max(1, (set.hp_current || 0) - drain);
          set.hp_updated_at = set.hp_current >= hpMaxV ? 0 : Date.now();
          undeadCurse.hpDrained = drain;
        }
      }
    }
  } else {
    // 失敗：25% 機率隨機掉 1 個非工具類道具（魚/礦/作物等，不掉裝備）
    const dropChance = dungeon?.hp?.deathDropChance ?? 0.25;
    if (Math.random() < dropChance) {
      const candidates = [];
      const bp = profile.backpack || {};
      for (const k of ["stone", "coal", "iron", "gold", "diamond", "monster_slime"]) {
        if ((bp[k] || 0) > 0) candidates.push({ kind: "ore", key: k });
      }
      const vb = profile.veggie_bag || {};
      for (const k of ["carrot", "corn", "strawberry", "black_rose"]) {
        if ((vb[k] || 0) > 0) candidates.push({ kind: "veggie", key: k });
      }
      const fb = profile.fish_bag || {};
      for (const k of ["small_fish", "crucian", "shark", "octopus", "lava_fish"]) {
        if ((fb[k] || 0) > 0) candidates.push({ kind: "fish", key: k });
      }
      if (candidates.length) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const path = pick.kind === "ore" ? "backpack" : pick.kind === "veggie" ? "veggie_bag" : "fish_bag";
        inc[`${path}.${pick.key}`] = (inc[`${path}.${pick.key}`] || 0) - 1;
        deathDrop = { kind: pick.kind, key: pick.key, qty: 1 };
      }
    }
  }

  // mini-BOSS 是「單次遭遇」：不論勝敗，打過就消耗這次遭遇（推進通關檢查點），
  // 必須重新刷 5F 才會再遇到 BOSS。放在勝敗分支外，戰敗也照樣消耗，避免被卡死。
  // 同時 +1 遭遇序號 → 下次遇到會輪替到不同 BOSS 變體（見 floorService.pickMiniBoss）。
  if (isMiniBoss) {
    Object.assign(set, floorService.buildMiniBossConsumeUpdate(profile, themeId).set);
    inc[`mini_boss_encounter_seq.${themeId}`] = (inc[`mini_boss_encounter_seq.${themeId}`] || 0) + 1;
  }

  await client.miningProfilesCollection.updateOne(
    { userId, guildId },
    { $inc: inc, $set: set },
  );

  let balance = null;
  let coinsGrantedTotal = coinsGained;
  if (coinsGained > 0) {
    const grant = await grantCoins(client, {
      userId, guildId, username,
      amount: coinsGained,
      source: "dungeon",
      member,
      meta: { theme: themeId, floor, monster: monster.name, overflow: oreOverflowToCoins || undefined },
    });
    balance = grant?.doc?.totalCoins ?? null;
    if (grant?.granted) coinsGrantedTotal = grant.granted;
  }

  // 戰鬥紀錄寫入 DungeonRuns（給玩家查紀錄 / mini-BOSS milestone）
  const runId = new ObjectId().toString();
  if (client.dungeonRunsCollection) {
    // started_at / ended_at 改存 BSON Date（原本 number 會讓 connectDb.js
    // 的 dungeon_runs_ttl_30d TTL 索引靜默失效，資料累積不會自動清）
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - battle.turns * 1000); // 估算
    client.dungeonRunsCollection.insertOne({
      run_id: runId,
      user_id: userId,
      guild_id: guildId,
      theme: themeId,
      floor,
      monster_id: monster.id,
      monster_name: monster.name,
      monster_emoji: monster.emoji,
      result: battle.result,
      battle_log: battle.log.slice(0, 100),
      damage_dealt: battle.damageDealt,
      damage_taken: battle.damageTaken,
      stamina_cost: staCost,
      pet_id: null,
      is_milestone: !!isMiniBoss, // mini-BOSS 紀念紀錄不走 30 天 TTL
      rewards: { coinsGained: coinsGrantedTotal, oreGained, legendaryGained, slimeGained, seedGained },
      started_at: startedAt,
      ended_at: endedAt,
    }).catch((e) => console.log(`[WARN] DungeonRuns insert: ${e.message}`.yellow));
  }

  const result = {
    ok: true,
    runId,
    theme: themeId,
    floor,
    floorName: f.name,
    isMiniBoss,
    // H7：mini-BOSS 勝利後算屠龍累積（含本次擊殺）
    dragonSlayerTotal: isMiniBoss && won
      ? (profile.dragon_slayer_kills || 0) + 1
      : null,
    floorEmoji: f.emoji,
    expectedTurns: f.expectedTurns,
    won,
    battleResult: battle.result,
    turns: battle.turns,
    log: battle.log,
    monster,
    atk,
    def,
    critRate,
    hpBefore: hpSt.hp,
    hpAfter: battle.playerEnd.hp_current,
    hpMax: hpMaxV,
    damageDealt: battle.damageDealt,
    damageTaken: battle.damageTaken,
    critCount: battle.critCount,
    blockCount: battle.blockCount,
    shield: profile.shield,
    shieldBefore: profile.shield_durability,
    shieldAfter: battle.playerEnd.shield_durability,
    potionsAfter: battle.playerEnd.potions,
    staminaBefore: st.stamina,
    staminaAfter: st.stamina - staCost,
    staminaMax: staMaxV,
    staminaBonus: staminaBonus(member),
    staminaCost: staCost,
    autoStamina,
    weaponBefore,
    weaponBroke,
    weaponDurabilityAfter,
    weaponDurabilityWarnCrossed,
    weaponDurabilityCost: wdurCost,
    legendarySwordBroke: weaponBroke && swordBreakService.isTrackedSword(weaponBefore),
    undeadCurse,
    loot,
    coinsGained: coinsGrantedTotal,
    coinsBase: coinsGained,
    clearRewardCoins,
    oreGained,
    oreOverflowToCoins,
    legendaryGained,
    potionGained,
    ticketGained,
    slimeGained,
    seedGained,
    deathDrop,
    floorEvents,
    balance,
    dungeonCount: (profile.dungeon_count || 0) + 1,
    foodBuffLines: formatFoodBuffLines(profile, "dungeon"),
  };

  // 傳說級以上的劍斷裂：記錄斷劍榜 + 公開播報（fire-and-forget，自帶錯誤吞掉）
  if (result.legendarySwordBroke) {
    swordBreakService
      .handleLegendaryBreak(client, { userId, guildId, weapon: weaponBefore })
      .catch(() => {});
  }

  // 事件 / 世界事件
  if (won) {
    require("../world_event/worldEventService")
      .rollTrigger(client, "dungeon_clear", { theme: themeId, floor })
      .catch(() => {});
  }

  bus.emit("dungeon.cleared", {
    userId, guildId,
    won,
    theme: themeId,
    floor,
    monster: monster.name,
    dungeonCount: result.dungeonCount,
  });

  for (const ev of result.floorEvents) {
    bus.emit("dungeon.floor_unlocked", { userId, guildId, theme: ev.theme, floor: ev.floor });
  }

  if (won && isMiniBoss) {
    const killCount = ((profile.mini_boss_kills || {})[themeId] || 0) + 1;
    bus.emit("dungeon.mini_boss_defeated", { userId, guildId, theme: themeId, killCount });
  }

  if (won) {
    if (oreGained?.qty > 0 && !oreOverflowToCoins) {
      bus.emit("item.gained", { userId, guildId, itemType: "ore", itemId: oreGained.ore, qty: oreGained.qty, source: "dungeon" });
    }
    if (legendaryGained > 0) {
      bus.emit("item.gained", { userId, guildId, itemType: "fragment", itemId: "legendary_fragment", qty: legendaryGained, source: "dungeon" });
    }
    if (potionGained > 0) {
      bus.emit("item.gained", { userId, guildId, itemType: "potion", itemId: "luck_potion", qty: potionGained, source: "dungeon" });
    }
    if (ticketGained > 0) {
      bus.emit("item.gained", { userId, guildId, itemType: "ticket", itemId: "cd_ticket", qty: ticketGained, source: "dungeon" });
    }
    if (slimeGained > 0) {
      bus.emit("item.gained", { userId, guildId, itemType: "monster_drop", itemId: "monster_slime", qty: slimeGained, source: "dungeon" });
    }
    if (seedGained?.qty > 0) {
      bus.emit("item.gained", { userId, guildId, itemType: "seed", itemId: seedGained.seedKey, qty: seedGained.qty, source: "dungeon" });
    }
  }

  // 突發事件（依樓層 encounterRatePct 觸發）：戰後寫庫已完成，事件再對 HP / 體力 / 庫存做變動
  const enc = await encounterService
    .trigger(client, {
      context: "dungeon",
      userId,
      guildId,
      member,
      username,
      baseResult: {
        ...result,
        stamina: result.staminaAfter,
        staminaMax: result.staminaMax,
      },
      encounterRatePct: f.encounterRatePct,
      themeId,
      battleResult: battle.result, // C2: 戰敗時略過 HP 回復類事件
    })
    .catch(() => null);
  if (enc) {
    if (typeof enc.patch?.staminaAfter === "number") {
      result.staminaAfter = enc.patch.staminaAfter;
    }
    result.encounter = { name: enc.name, emoji: enc.emoji, body: enc.body, loot: enc.loot || [], outcome: enc.outcome || null };
    if (enc.diamondGained > 0) result.encounterDiamond = enc.diamondGained;
  }

  // 選擇事件：沒觸發自動突發事件、也非 mini-BOSS 時，有機率丟一個「帶選項」的事件，
  // 讓玩家在結果面板上做選擇（點按鈕後才擲骰結算，見 choiceEventService）。
  if (!result.encounter && !isMiniBoss) {
    const choiceCfg = dungeon?.choiceEvents;
    if (choiceCfg?.enabled && Math.random() < (choiceCfg.chance || 0)) {
      const choiceEventService = require("../dungeon/choiceEventService");
      const picked = choiceEventService.pickChoiceEvent();
      if (picked) result.choiceEvent = picked;
    }
  }

  result.xpGained = await grantActivityXp(client, "dungeon", {
    userId,
    guildId,
    username,
    member,
    meta: { won, floor, theme: themeId, isMiniBoss },
  });

  return result;
}

// 查 HP 狀態（給 /地下城 狀態、entry 面板用）
async function getDungeonStatus(client, { userId, guildId, member }) {
  const club = await getMemberClub(client, userId, guildId);
  const staMaxV = staminaMax(member, club);
  const level = await getPlayerLevel(client, userId, guildId);
  const profile = await getOrCreate(client, userId, guildId);
  const st = resolveStamina(profile, staMaxV);
  // 與 enterDungeonHp 同口徑：把世界事件 + 公會 buff dungeon_hp_max 都加上，避免面板與實戰數值不一致
  const hpMaxV = await effectiveHpMax(client, { userId, guildId, profile, club, level });
  const hpSt = hpService.resolveHp(profile, hpMaxV);
  const themes = floorService.listThemes(profile, level);
  return {
    profile, level, club,
    stamina: st.stamina,
    staminaMax: staMaxV,
    staminaNextRegenAt: st.nextRegenAt,
    hp: hpSt.hp,
    hpMax: hpMaxV,
    hpNextRegenAt: hpSt.nextRegenAt,
    themes,
    hpLow: hpService.isLowHp(hpSt.hp, hpMaxV),
    hpCritical: hpService.isCriticalHp(hpSt.hp, hpMaxV),
    potions: {
      small: profile.hp_potion_small || 0,
      medium: profile.hp_potion_medium || 0,
      large: profile.hp_potion_large || 0,
    },
    weapon: profile.weapon,
    weaponDurability: profile.weapon_durability,
    weaponMaxDurability: effectiveMaxOf(
      profile,
      "weapon",
      clubBuildingPct(club, "equipment_max_durability_pct")
    ),
    shield: profile.shield,
    shieldDurability: profile.shield_durability,
    shieldMaxDurability: effectiveMaxOf(
      profile,
      "shield",
      clubBuildingPct(club, "equipment_max_durability_pct")
    ),
    autoPotion: profile.dungeon_auto_potion !== false,
    autoPotionTier: profile.dungeon_auto_potion_tier || "smallest",
    autoStamina: profile.dungeon_auto_stamina === true,
    autoStaminaTier: profile.dungeon_auto_stamina_tier || "smallest",
  };
}

// Phase H+ 設定面板：寫入自動藥水偏好。
async function setAutoPotionPref(client, { userId, guildId, autoPotion, tier, autoStamina, staminaTier }) {
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const set = { updatedAt: new Date() };
  const VALID_TIERS = ["smallest", "largest", "small", "medium", "large"];
  if (typeof autoPotion === "boolean") set.dungeon_auto_potion = autoPotion;
  if (tier && VALID_TIERS.includes(tier)) set.dungeon_auto_potion_tier = tier;
  if (typeof autoStamina === "boolean") set.dungeon_auto_stamina = autoStamina;
  if (staminaTier && VALID_TIERS.includes(staminaTier)) set.dungeon_auto_stamina_tier = staminaTier;
  if (Object.keys(set).length <= 1) return { ok: false, reason: "no_change" };
  await client.miningProfilesCollection.updateOne({ userId, guildId }, { $set: set });
  return { ok: true };
}

module.exports = {
  enterDungeon,
  enterDungeonHp,
  getDungeonStatus,
  getPlayerLevel,
  effectiveHpMax,
  setAutoPotionPref,
  rollbackDungeon,
  resolveStamina,
  restoreStamina,
  useStaminaPotion,
  totalStaminaPotions,
  staminaPotionRestore,
  STAMINA_POTION_TIERS,
  staminaMax,
  staminaBonus,
  staminaGuildBonus,
  getMemberClub,
  staminaFullAt,
  playerAtk,
  hasWeapon,
};
