// Phase H+ HP 系統：自然回復、HP 上限計算、HP 藥水使用、重傷判定
//
// 自然回復：每 10 分鐘 +5 HP，離線也算，上限 = hp_max。
// HP 上限：baseMax(100) + Lv ×2 + 食物 buff(dungeon_hp_max) + 公會 buff + 寵物 buff（v1 不一定有）。
// HP 藥水：小(+20) / 中(+50) / 大(滿)，扣對應欄位、寫 hp_current。

const { dungeon } = require("../../config");
const { getOrCreate } = require("../mining/miningProfile");

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// HP 上限：基準 + 等級加成 + 食物 buff（其他 buff 由呼叫端疊加）
function hpMax(level = 0, extras = {}) {
  const cfg = dungeon?.hp || {};
  const base = cfg.baseMax ?? 100;
  const lvBonus = (cfg.levelBonus ?? 2) * (level || 0);
  const food = extras.food || 0;
  const guild = extras.guild || 0;
  const pet = extras.pet || 0;
  return base + lvBonus + food + guild + pet;
}

// 惰性自然回復：依離線時間補 HP。
// - 滿 HP 時 updatedAt 視為 0（計時器停擺）、nextRegenAt = null。
// - 不滿時用 (now - updatedAt) / interval 計算回了幾個 tick。
function resolveHp(profile, max) {
  const cfg = dungeon?.hp || {};
  const interval = cfg.naturalRegenIntervalMs ?? 600000; // 10 min
  const perTick = cfg.naturalRegenPer10Min ?? 5;
  let hp = typeof profile?.hp_current === "number" ? profile.hp_current : max;
  let updatedAt = profile?.hp_updated_at || 0;

  if (hp >= max) {
    return { hp: max, updatedAt: 0, nextRegenAt: null };
  }

  const now = Date.now();
  if (!updatedAt) updatedAt = now;
  const ticks = Math.floor((now - updatedAt) / interval);
  if (ticks > 0) {
    hp = Math.min(max, hp + ticks * perTick);
    updatedAt = updatedAt + ticks * interval;
  }

  if (hp >= max) {
    return { hp: max, updatedAt: 0, nextRegenAt: null };
  }
  return { hp, updatedAt, nextRegenAt: updatedAt + interval };
}

function isLowHp(hpCurrent, hpMaxVal) {
  const ratio = dungeon?.hp?.lowHpRatio ?? 0.3;
  return hpCurrent / hpMaxVal < ratio;
}

function isCriticalHp(hpCurrent, hpMaxVal) {
  const ratio = dungeon?.hp?.criticalHpRatio ?? 0.2;
  return hpCurrent / hpMaxVal < ratio;
}

// 估算「HP 補滿」的 epoch ms。已滿回 0。
function hpFullAt(profile, max) {
  const cfg = dungeon?.hp || {};
  const interval = cfg.naturalRegenIntervalMs ?? 600000;
  const perTick = cfg.naturalRegenPer10Min ?? 5;
  const st = resolveHp(profile, max);
  if (st.hp >= max) return 0;
  const baseAt = st.updatedAt || Date.now();
  const need = Math.ceil((max - st.hp) / perTick);
  return baseAt + need * interval;
}

// 使用 HP 藥水：扣 1 瓶 + 補 HP。
// tier: 'small' | 'medium' | 'large'
async function useHpPotion(client, { userId, guildId, tier, level = 0, extras = {}, hpMaxVal }) {
  if (!client?.miningProfilesCollection) return { ok: false, reason: "disabled" };
  const def = dungeon?.hpPotions?.[tier];
  if (!def) return { ok: false, reason: "unknown_potion" };

  const field = `hp_potion_${tier}`;
  // 上限以呼叫端算好的口徑為準（含食物 / 公會 / 世界事件 buff）；沒帶就退回 base + 等級。
  const max = typeof hpMaxVal === "number" ? hpMaxVal : hpMax(level, extras);
  const profile = await getOrCreate(client, userId, guildId);
  const owned = profile[field] || 0;
  if (owned <= 0) return { ok: false, reason: "no_potion" };

  const st = resolveHp(profile, max);
  if (st.hp >= max) {
    return { ok: false, reason: "full", hp: st.hp, hpMax: max };
  }

  const restore = def.restore || 0;
  const before = st.hp;
  const after = Math.min(max, st.hp + restore);
  const newUpdatedAt = after >= max ? 0 : st.updatedAt || Date.now();

  // 原子扣 1 瓶 + 寫 HP（防連點重複扣）
  const filter = { userId, guildId };
  filter[field] = { $gte: 1 };
  const inc = {};
  inc[field] = -1;
  const updated = await client.miningProfilesCollection.findOneAndUpdate(
    filter,
    {
      $inc: inc,
      $set: {
        hp_current: after,
        hp_updated_at: newUpdatedAt,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );
  const doc = updated?.value || updated;
  if (!doc) return { ok: false, reason: "retry" };

  return {
    ok: true,
    tier,
    restore: after - before,
    hpBefore: before,
    hpAfter: after,
    hpMax: max,
    potionLeft: doc[field] || 0,
  };
}

// 把戰鬥後新的 hp_current 寫回 DB（戰鬥引擎跑完後的 finalize）。
// 體力 / 武器耐久仍由 dungeonService 統一處理；這邊只動 HP / 盾耐久 / 藥水。
async function writeBattleEnd(client, { userId, guildId, hpAfter, hpMaxVal, shieldDurabilityAfter, potionsAfter }) {
  if (!client?.miningProfilesCollection) return;
  const set = {
    hp_current: Math.max(0, Math.min(hpMaxVal, hpAfter)),
    hp_updated_at: hpAfter >= hpMaxVal ? 0 : Date.now(),
    updatedAt: new Date(),
  };
  if (typeof shieldDurabilityAfter === "number") {
    set.shield_durability = shieldDurabilityAfter;
  }
  if (potionsAfter) {
    if (typeof potionsAfter.small === "number") set.hp_potion_small = potionsAfter.small;
    if (typeof potionsAfter.medium === "number") set.hp_potion_medium = potionsAfter.medium;
    if (typeof potionsAfter.large === "number") set.hp_potion_large = potionsAfter.large;
  }
  await client.miningProfilesCollection.updateOne({ userId, guildId }, { $set: set });
}

module.exports = {
  hpMax,
  resolveHp,
  hpFullAt,
  isLowHp,
  isCriticalHp,
  useHpPotion,
  writeBattleEnd,
};
