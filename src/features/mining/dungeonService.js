require("colors");
const { mining, dungeon, shop, guildClub } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("./twitchPerks");
const encounterService = require("./encounterService");
const { getFoodAtkBonus, formatFoodBuffLines } = require("../fishing/cookService");
const bus = require("../eventBus");

// CD 縮短券持有上限（與商店 shop.json maxStack 一致）
const CD_TICKET_MAX = 60;

// CD 縮短券滿倉時的折算金幣價（取商店售價，fallback 150）
function cdTicketCoinValue() {
  const item = (shop?.items || []).find((i) => i.type === "mining_cd_ticket");
  return item?.price || 150;
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
  return base + staminaBonus(member) + staminaGuildBonus(club);
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

// 使用一瓶體力藥水：扣 1 罐 + 補體力。庫存或體力滿時各自回傳對應 reason。
async function useStaminaPotion(client, { userId, guildId, member }) {
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const club = await getMemberClub(client, userId, guildId);
  const max = staminaMax(member, club);
  const profile = await getOrCreate(client, userId, guildId);

  const owned = profile.stamina_potion_count || 0;
  if (owned <= 0) return { ok: false, reason: "no_potion" };

  const st = resolveStamina(profile, max);
  if (st.stamina >= max) {
    return { ok: false, reason: "full", staminaBefore: st.stamina, max };
  }

  const { shop } = require("../../config");
  const item = (shop?.items || []).find((i) => i.type === "mining_stamina_potion");
  const restore = item?.payload?.restore || 5;

  // 原子扣減：filter 帶 stamina_potion_count >= 1，防止連點重複扣
  const updated = await client.miningProfilesCollection.findOneAndUpdate(
    { userId, guildId, stamina_potion_count: { $gte: 1 } },
    { $inc: { stamina_potion_count: -1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  const updatedDoc = updated?.value || updated;
  if (!updatedDoc) return { ok: false, reason: "retry" };

  const restored = await restoreStamina(client, { userId, guildId, member, amount: restore });
  return {
    ok: true,
    staminaBefore: restored.staminaBefore,
    staminaAfter: restored.staminaAfter,
    restored: restored.restored,
    max: restored.max,
    potionLeft: updatedDoc.stamina_potion_count || 0,
    nextRegenAt: restored.nextRegenAt,
  };
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
      potionCount: profile.stamina_potion_count || 0,
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
  // 訓練場 + 世界事件 dungeon_damage_pct 把 atk 拉高（兩者皆是「百分比加成」）
  const dmgPct = clubBuildingPct(club, "dungeon_damage_pct") + worldEventPct("dungeon_damage_pct");
  const baseAtk = playerAtk(profile);
  const atk = Math.floor(baseAtk * (100 + dmgPct) / 100);
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
    weaponDurabilityAfter = before - 1;
    if (weaponDurabilityAfter <= 0) {
      weaponBroke = true;
      weaponDurabilityAfter = null;
      set.weapon = "fist";
      set.weapon_durability = null;
    } else {
      inc.weapon_durability = -1;
      const warn = dungeon?.durabilityWarn || {};
      if (typeof warn.critical === "number" && before > warn.critical && weaponDurabilityAfter <= warn.critical) {
        weaponDurabilityWarnCrossed = "critical";
      } else if (typeof warn.low === "number" && before > warn.low && weaponDurabilityAfter <= warn.low) {
        weaponDurabilityWarnCrossed = "low";
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
  let ticketOverflowToCoins = false;
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
      const owned = profile.cd_ticket_count || 0;
      const want = loot.qty || 1;
      ticketGained = Math.min(want, Math.max(0, CD_TICKET_MAX - owned));
      if (ticketGained > 0) {
        inc.cd_ticket_count = (inc.cd_ticket_count || 0) + ticketGained;
      }
      // 滿倉的部分折算成金幣，避免撿到的券白白浪費
      const overflow = want - ticketGained;
      if (overflow > 0) {
        coinsGained += overflow * cdTicketCoinValue();
        ticketOverflowToCoins = true;
      }
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
    coinsGained,
    oreGained,
    oreOverflowToCoins,
    legendaryGained,
    potionGained,
    ticketGained,
    ticketOverflowToCoins,
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
    foodBuffLines: formatFoodBuffLines(profile, "dungeon"),
  };

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
    result.encounter = { name: enc.name, emoji: enc.emoji, body: enc.body };
  }

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

module.exports = {
  enterDungeon,
  rollbackDungeon,
  resolveStamina,
  restoreStamina,
  useStaminaPotion,
  staminaMax,
  staminaBonus,
  staminaGuildBonus,
  getMemberClub,
  staminaFullAt,
  playerAtk,
  hasWeapon,
};
