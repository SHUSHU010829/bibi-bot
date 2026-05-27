require("colors");
const { mining, dungeon } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed } = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const grantCoins = require("../economy/grantCoins");

function rollLoot() {
  const table = dungeon?.loot || [];
  const weights = {};
  for (const l of table) weights[l.id] = l.weight;
  const id = weightedRandom(weights);
  return table.find((l) => l.id === id) || { id: "nothing" };
}

function staminaMax() {
  return dungeon?.staminaMax ?? 10;
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

function playerAtk(profile) {
  const base = dungeon?.baseAtk ?? 30;
  const map = dungeon?.pickaxeAtk || {};
  return base + (map[profile?.pickaxe] || 0);
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

  const max = staminaMax();
  const profile = await getOrCreate(client, userId, guildId);
  const st = resolveStamina(profile, max);

  if (st.stamina <= 0) {
    return { ok: false, reason: "no_stamina", nextRegenAt: st.nextRegenAt, max };
  }

  // 消耗 1 點體力；若原本是滿的，從現在開始起算回復計時。
  const now = Date.now();
  const wasFull = st.stamina >= max;
  const newStamina = st.stamina - 1;
  const newUpdatedAt = wasFull ? now : st.updatedAt;

  const monster = rollMonster();
  const atk = playerAtk(profile);
  const winRate = clamp(
    atk / monster.hp,
    dungeon?.winRateMin ?? 0.2,
    dungeon?.winRateMax ?? 0.9
  );
  const won = Math.random() < winRate;

  const set = {
    stamina: newStamina,
    stamina_updated_at: newUpdatedAt,
    updatedAt: new Date(),
  };
  const inc = { dungeon_count: 1 };

  // 戰利品（僅勝利時）
  let loot = { id: "nothing" };
  if (won) {
    loot = rollLoot();
  }

  let coinsGained = 0;
  let oreGained = null; // { ore, qty }
  let oreOverflowToCoins = false;
  let legendaryGained = 0;

  if (won && loot.id === "ore_fragment") {
    const oreKey = loot.ore || "iron";
    const qty = loot.qty || 1;
    const cap = backpackCapacity(profile, mining);
    const used = backpackUsed(profile);
    const space = Math.max(0, cap - used);
    if (space >= qty) {
      inc[`backpack.${oreKey}`] = qty;
      oreGained = { ore: oreKey, qty };
    } else {
      // 背包滿了就折算成等值金幣，避免戰利品憑空消失
      const price = mining?.ores?.[oreKey]?.price || 0;
      coinsGained = price * qty;
      oreOverflowToCoins = true;
      oreGained = { ore: oreKey, qty };
    }
  } else if (won && loot.id === "coins") {
    const lo = loot.minCoins ?? 150;
    const hi = loot.maxCoins ?? 300;
    coinsGained = Math.floor(Math.random() * (hi - lo + 1)) + lo;
  } else if (won && loot.id === "legendary_fragment") {
    legendaryGained = loot.qty || 1;
    inc.legendary_fragments = legendaryGained;
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

  return {
    ok: true,
    won,
    monster,
    atk,
    winRate,
    loot,
    coinsGained,
    oreGained,
    oreOverflowToCoins,
    legendaryGained,
    balance,
    stamina: newStamina,
    staminaMax: max,
    staminaNextRegenAt: resolveStamina(
      { stamina: newStamina, stamina_updated_at: newUpdatedAt },
      max
    ).nextRegenAt,
    dungeonCount: (profile.dungeon_count || 0) + 1,
  };
}

module.exports = { enterDungeon, resolveStamina, staminaMax, playerAtk };
