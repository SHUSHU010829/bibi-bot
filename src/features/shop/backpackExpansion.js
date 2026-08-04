const { mining, dungeon } = require("../../config");

// 背包擴充的計價與門檻：三袋共用 backpack_bonus_slots，所以容量只有一條軸。
// flatUntilSlots 以下維持原本的固定單價；之上每跨 bandSlots 一段，單價 ×bandPriceMultiplier。
// maxSlots 是硬上限，買不過去。

function cfg() {
  return mining?.backpackExpansion || {};
}

function baseSlots() {
  return mining?.backpackBaseSlots ?? 100;
}

function maxSlots() {
  return cfg().maxSlots ?? Infinity;
}

// 已超過上限的舊帳號不縮水，照實回報；上限只用來擋購買。
function capacityOf(profile) {
  return baseSlots() + (profile?.backpack_bonus_slots || 0);
}

// 目前容量下，下一筆擴充（一筆 = payload.slots 格）要多少錢。
// bands 由低到高分段，各段有自己的漲幅；後段從前段結束的價位接著往上乘。
function chunkPrice(capacity, basePrice) {
  const { flatUntilSlots, bands = [] } = cfg();
  if (!(flatUntilSlots > 0) || capacity < flatUntilSlots) return basePrice;

  let price = basePrice;
  for (let i = 0; i < bands.length; i++) {
    const seg = bands[i];
    if (capacity <= seg.fromSlots) break;
    const segEnd = bands[i + 1]?.fromSlots ?? Infinity;
    const upto = Math.min(capacity, segEnd);
    const steps = Math.floor((upto - seg.fromSlots) / (seg.bandSlots || 500));
    price *= Math.pow(seg.priceMultiplier || 1, steps);
  }
  return Math.round(price);
}

// 從目前容量起算，買 chunks 筆的總價與實際可買筆數（撞到上限就截斷）。
function quote(profile, chunks, item) {
  const slotsPerChunk = item?.payload?.slots || 5;
  const basePrice = item?.price || 0;
  const cap = maxSlots();
  let capacity = capacityOf(profile);
  let bought = 0;
  let totalPrice = 0;
  for (let i = 0; i < chunks && capacity < cap; i++) {
    totalPrice += chunkPrice(capacity, basePrice);
    capacity = Math.min(cap, capacity + slotsPerChunk);
    bought++;
  }
  return {
    chunks: bought,
    totalPrice,
    slotsPerChunk,
    slotsGained: capacity - capacityOf(profile),
    capacityBefore: capacityOf(profile),
    capacityAfter: capacity,
    atCap: capacityOf(profile) >= cap,
    nextPrice: capacity < cap ? chunkPrice(capacity, basePrice) : null,
  };
}

// 從 fromCapacity 擴充到 toCapacity 總共要花多少（用同一條價格曲線反推）。
// 上限下修時用來計算該退還多少金幣。
function costBetween(fromCapacity, toCapacity, basePrice, slotsPerChunk = 5) {
  let total = 0;
  for (let cap = fromCapacity; cap < toCapacity; cap += slotsPerChunk) {
    total += chunkPrice(cap, basePrice);
  }
  return total;
}

// 這次購買會跨過的門檻（已經在目前容量之下的不追溯）。
function gatesCrossed(capacityBefore, capacityAfter) {
  return (cfg().gates || []).filter(
    (g) => g.aboveSlots >= capacityBefore && g.aboveSlots < capacityAfter,
  );
}

// 多道門檻合併：同一項要求取最嚴格的。
function mergeRequirements(gates) {
  const merged = {};
  for (const g of gates) {
    for (const [key, value] of Object.entries(g.require || {})) {
      if (key === "dungeonTheme") {
        merged.dungeonTheme = value;
      } else if (!(merged[key] >= value)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function themeName(themeId) {
  const t = (dungeon?.themes || []).find((x) => x.id === themeId);
  return t ? `${t.emoji || ""}${t.name}`.trim() : themeId;
}

// 逐項比對門檻，回傳未達標的中文說明（含目前進度）。
async function checkRequirements(
  client,
  { userId, guildId, profile, capacityBefore, capacityAfter, level: knownLevel },
) {
  const gates = gatesCrossed(capacityBefore, capacityAfter);
  if (gates.length === 0) return { ok: true, missing: [] };

  const req = mergeRequirements(gates);
  const missing = [];

  if (req.level > 0) {
    const { getPlayerLevel } = require("../mining/dungeonService");
    const level =
      typeof knownLevel === "number" ? knownLevel : await getPlayerLevel(client, userId, guildId);
    if (level < req.level) {
      missing.push({ label: "等級", need: `Lv.${req.level}`, have: `Lv.${level}` });
    }
  }
  if (req.mineCount > 0) {
    const have = profile?.mine_count_total || 0;
    if (have < req.mineCount) {
      missing.push({
        label: "累計挖礦次數",
        need: `${req.mineCount.toLocaleString()} 次`,
        have: `${have.toLocaleString()} 次`,
      });
    }
  }
  if (req.legendaryFragments > 0) {
    const have = profile?.legendary_fragments || 0;
    if (have < req.legendaryFragments) {
      missing.push({
        label: "✨ 傳說素材碎片",
        need: `${req.legendaryFragments} 個`,
        have: `${have} 個`,
      });
    }
  }
  if (req.dungeonTheme) {
    const unlocked = (profile?.floor_unlocks?.[req.dungeonTheme]?.max_floor || 0) > 0;
    if (!unlocked) {
      missing.push({
        label: `地下城「${themeName(req.dungeonTheme)}」`,
        need: "已解鎖",
        have: "尚未解鎖",
      });
    }
  }

  return { ok: missing.length === 0, missing, requirements: req };
}

// 這次最多能買幾筆：先撞硬上限，再撞最近一道未達成的門檻。
async function maxChunksNow(client, { userId, guildId, profile, item }) {
  const slotsPerChunk = item?.payload?.slots || 5;
  const capacity = capacityOf(profile);
  const roomChunks = Math.floor((maxSlots() - capacity) / slotsPerChunk);
  if (roomChunks <= 0) return 0;

  const gates = (cfg().gates || [])
    .filter((g) => g.aboveSlots >= capacity)
    .sort((a, b) => a.aboveSlots - b.aboveSlots);
  if (gates.length === 0) return roomChunks;

  // 等級只查一次，否則每道門檻都會打一次 DB。
  const { getPlayerLevel } = require("../mining/dungeonService");
  const level = await getPlayerLevel(client, userId, guildId);

  for (const gate of gates) {
    const check = await checkRequirements(client, {
      userId,
      guildId,
      profile,
      capacityBefore: capacity,
      capacityAfter: gate.aboveSlots + 1,
      level,
    });
    if (!check.ok) {
      return Math.max(0, Math.floor((gate.aboveSlots - capacity) / slotsPerChunk));
    }
  }
  return roomChunks;
}

// 這次擴充是否被擋下。回傳 null 表示可以買；否則給出 errorKind + 差距明細。
// 扣款路徑（buyItem）與顯示路徑（商店按鈕）共用這支，避免兩邊判斷不一致。
async function describeBlock(client, { userId, guildId, profile, item, chunks = 1 }) {
  const q = quote(profile, chunks, item);
  if (q.atCap) {
    return {
      errorKind: "backpack_cap",
      error: `背包容量已達上限 ${maxSlots().toLocaleString()} 格，無法再擴充。`,
      detail: { capacity: q.capacityBefore, max: maxSlots() },
      quote: q,
    };
  }
  const check = await checkRequirements(client, {
    userId,
    guildId,
    profile,
    capacityBefore: q.capacityBefore,
    capacityAfter: q.capacityAfter,
  });
  if (!check.ok) {
    return {
      errorKind: "backpack_gate",
      error: `擴充到 ${q.capacityAfter.toLocaleString()} 格的條件尚未達成：${check.missing
        .map((m) => `${m.label} 需要 ${m.need}（目前 ${m.have}）`)
        .join("、")}`,
      detail: { ...q, missing: check.missing },
      quote: q,
    };
  }
  return null;
}

module.exports = {
  capacityOf,
  chunkPrice,
  costBetween,
  quote,
  describeBlock,
  gatesCrossed,
  checkRequirements,
  maxChunksNow,
  baseSlots,
  maxSlots,
};
