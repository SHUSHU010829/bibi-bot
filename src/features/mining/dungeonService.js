require("colors");
const { mining, dungeon, shop } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const grantCoins = require("../economy/grantCoins");
const twitchPerks = require("./twitchPerks");
const encounterService = require("./encounterService");
const { getFoodAtkBonus } = require("../fishing/cookService");

// CD 縮短券持有上限（與商店 shop.json maxStack 一致）
const CD_TICKET_MAX = 30;

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

function rollLoot() {
  const table = dungeon?.loot || [];
  const weights = {};
  for (const l of table) weights[l.id] = l.weight;
  const id = weightedRandom(weights);
  return table.find((l) => l.id === id) || { id: "nothing", kind: "nothing" };
}

function staminaBonus(member) {
  return twitchPerks.resolvePerks(member)?.staminaBonus || 0;
}

function staminaMax(member) {
  const base = dungeon?.staminaMax ?? 10;
  return base + staminaBonus(member);
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
  const max = staminaMax(member);
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

// 估算「體力補滿」的 epoch ms。已滿回 0；用於到點通知與 /通知設定 面板。
// member 可選，用於把 Twitch 訂閱的體力上限加乘算進去。
async function staminaFullAt(client, { userId, guildId, member }) {
  if (!client?.miningProfilesCollection) return 0;
  const max = staminaMax(member);
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
async function enterDungeon(client, { userId, guildId, member, username }) {
  if (!dungeon?.enabled) return { ok: false, reason: "disabled" };
  if (!client.miningProfilesCollection) return { ok: false, reason: "disabled" };

  const max = staminaMax(member);
  const bonus = staminaBonus(member);
  const profile = await getOrCreate(client, userId, guildId);

  const st = resolveStamina(profile, max);

  if (st.stamina <= 0) {
    return { ok: false, reason: "no_stamina", nextRegenAt: st.nextRegenAt, max, staminaBonus: bonus };
  }

  // 消耗 1 點體力；若原本是滿的，從現在開始起算回復計時。
  const now = Date.now();
  const wasFull = st.stamina >= max;
  const newStamina = st.stamina - 1;
  const newUpdatedAt = wasFull ? now : st.updatedAt;

  const monster = rollMonster();
  const atk = playerAtk(profile);
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
  const critRate = wdef.critRate || 0;
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
  const weaponBefore = profile.weapon;
  const hasWeaponDurability =
    profile.weapon !== "fist" && typeof profile.weapon_durability === "number";
  if (hasWeaponDurability) {
    weaponDurabilityAfter = profile.weapon_durability - 1;
    if (weaponDurabilityAfter <= 0) {
      weaponBroke = true;
      weaponDurabilityAfter = null;
      set.weapon = "fist";
      set.weapon_durability = null;
    } else {
      inc.weapon_durability = -1;
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

  if (won) {
    loot = rollLoot();
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
  };

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

  const max = staminaMax(member);
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
  staminaMax,
  staminaBonus,
  staminaFullAt,
  playerAtk,
  hasWeapon,
};
