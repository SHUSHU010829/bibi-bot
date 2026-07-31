require("colors");
const { mining } = require("../../config");
const { getOrCreate, backpackCapacity, backpackUsed, ORE_KEYS } = require("./miningProfile");
const { weightedRandom } = require("./weightedRandom");
const grantActivityXp = require("../leveling/grantActivityXp");
const bus = require("../eventBus");

const cfg = () => mining?.deepVein || {};
const isEnabled = () => !!cfg().enabled;

// 深層礦脈用自己的體力池，與地下城互不干擾。回復採和地下城相同的惰性換算
// （不排程、用到時才依經過時間補；滿了把 updated_at 設 0 停錶），但
// dungeonService.resolveStamina 的欄位名是寫死的，沒辦法直接套用另一組欄位。
const STAMINA_FIELD = "deep_stamina";
const STAMINA_AT_FIELD = "deep_stamina_updated_at";

function staminaMax() {
  return cfg().staminaMax ?? 10;
}

function resolveDeepStamina(profile) {
  const max = staminaMax();
  const regenMs = cfg().staminaRegenMs ?? 10800000;
  const cur = profile?.[STAMINA_FIELD];
  const updatedAt = profile?.[STAMINA_AT_FIELD] || 0;

  if (typeof cur !== "number") return { stamina: max, max, nextRegenAt: null };
  if (cur >= max) return { stamina: max, max, nextRegenAt: null };
  if (!updatedAt) return { stamina: cur, max, nextRegenAt: null };

  const elapsed = Date.now() - updatedAt;
  const regened = Math.floor(elapsed / regenMs);
  const stamina = Math.min(max, cur + Math.max(0, regened));
  const nextRegenAt =
    stamina >= max ? null : updatedAt + (regened + 1) * regenMs;
  return { stamina, max, nextRegenAt, regened: Math.max(0, regened) };
}

// 深層礦脈的產出量：刻意不吃 mining_qty_bonus。
// 鑽石鎬 +1 與公會 Lv2 +1 是為舊礦坑的機率表平衡設計的，帶進來會讓每種產出
// 都 ×3，鑽石通膨最嚴重。這裡只認礦石自身的 minQty/maxQty。
function rollDeep() {
  const table = cfg().dropTable || {};
  const ore = weightedRandom(table);
  if (!ore) return null;
  const def = mining?.ores?.[ore] || {};
  const min = def.minQty ?? 1;
  const max = def.maxQty ?? min;
  return { ore, qty: Math.floor(Math.random() * (max - min + 1)) + min };
}

// 全服是否已解鎖（主線活動達標後寫入的永久旗標，不是會過期的 buff）
async function isUnlocked(client, guildId) {
  if (!client?.serverFlagsCollection) return false;
  const doc = await client.serverFlagsCollection
    .findOne({ guildId, key: "deep_vein_unlocked" })
    .catch(() => null);
  return !!doc?.value;
}

async function unlock(client, guildId) {
  if (!client?.serverFlagsCollection) return { ok: false, reason: "disabled" };
  await client.serverFlagsCollection.updateOne(
    { guildId, key: "deep_vein_unlocked" },
    { $set: { value: true, unlocked_at: new Date() } },
    { upsert: true },
  );
  return { ok: true };
}

async function deepMine(client, { userId, guildId, member, username }) {
  if (!isEnabled() || !client.miningProfilesCollection) {
    return { ok: false, reason: "disabled" };
  }
  if (!(await isUnlocked(client, guildId))) {
    return { ok: false, reason: "locked_server" };
  }
  const needLevel = cfg().unlockLevel ?? 30;
  const userLevel = await client.userLevelsCollection
    ?.findOne({ userId, guildId })
    .catch(() => null);
  const level = userLevel?.level ?? 0;
  if (level < needLevel) {
    return { ok: false, reason: "locked_level", need: needLevel, have: level };
  }

  const profile = await getOrCreate(client, userId, guildId);
  const { stamina, max, nextRegenAt } = resolveDeepStamina(profile);
  const cost = cfg().staminaCost ?? 1;
  if (stamina < cost) {
    return { ok: false, reason: "no_stamina", stamina, max, nextRegenAt };
  }

  const cap = backpackCapacity(profile, mining);
  const used = backpackUsed(profile);
  if (used >= cap) return { ok: false, reason: "backpack_full", used, cap };

  const drop = rollDeep();
  if (!drop) return { ok: false, reason: "no_drop" };
  const qty = Math.min(drop.qty, Math.max(0, cap - used));

  const after = stamina - cost;
  const inc = {
    deep_mine_count_total: 1,
    [`backpack.${drop.ore}`]: qty,
    [`lifetime_ore.${drop.ore}`]: qty,
  };
  // 體力未滿才需要計時；滿的時候 updated_at 設 0 代表「停錶」
  const set = {
    [STAMINA_FIELD]: after,
    [STAMINA_AT_FIELD]: after >= max ? 0 : Date.now(),
    updatedAt: new Date(),
  };

  await client.miningProfilesCollection.updateOne({ userId, guildId }, { $inc: inc, $set: set });

  const xpGained = await grantActivityXp(client, "mine", {
    userId, guildId, username, member, meta: { ore: drop.ore, deep: true },
  });

  bus.emit("item.gained", {
    userId, guildId, itemType: "ore", itemId: drop.ore, qty, source: "deep_mine",
  });

  return {
    ok: true,
    ore: drop.ore,
    qty,
    oreDef: mining?.ores?.[drop.ore] || {},
    stamina: after,
    staminaMax: max,
    nextRegenAt: after >= max ? null : Date.now() + (cfg().staminaRegenMs ?? 10800000),
    xpGained,
    backpackUsed: used + (ORE_KEYS.includes(drop.ore) ? qty : 0),
    backpackCap: cap,
  };
}

module.exports = {
  isEnabled,
  isUnlocked,
  unlock,
  resolveDeepStamina,
  rollDeep,
  deepMine,
  staminaMax,
  STAMINA_FIELD,
  STAMINA_AT_FIELD,
};
