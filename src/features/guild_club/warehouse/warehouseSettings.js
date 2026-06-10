const { guildWarehouse } = require("../../../config");

const dayKeyOf = (date = new Date()) => {
  const offsetMs = 8 * 3600 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  return local.toISOString().slice(0, 10);
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const itemDef = (itemId) => guildWarehouse?.items?.[itemId] || null;

const allItemIds = () => Object.keys(guildWarehouse?.items || {});

const capacityFor = (itemId, clubLevel, override, club) => {
  const def = itemDef(itemId);
  if (!def) return 0;
  const base = override?.capacity?.[itemId] ?? def.capacityDefault;
  const mult = guildWarehouse.capacityLevelMultiplier?.[String(clubLevel)] ?? 1.0;
  const baseCap = Math.floor(base * mult);
  // 倉庫擴建建築加成：對每個物品額外加 Σ capacity_bonus。
  // require 放這裡避免 circular（buildingService → warehouseSettings 反向沒問題）。
  if (club) {
    try {
      const buildingService = require("../buildingService");
      return baseCap + buildingService.warehouseCapacityBonus(club);
    } catch (_) {
      return baseCap;
    }
  }
  return baseCap;
};

const perTakeMaxFor = (itemId, override) => {
  const def = itemDef(itemId);
  if (!def) return 0;
  const setVal = override?.perTakeMax?.[itemId];
  if (typeof setVal === "number") {
    const [lo, hi] = def.perTakeMaxRange;
    return clamp(setVal, lo, hi);
  }
  return def.perTakeMaxDefault;
};

const resolveSettings = (club) => {
  const w = guildWarehouse?.withdraw || {};
  const override = club?.warehouse_settings || {};
  const pick = (key, range) => {
    const v = override[key];
    if (typeof v === "number") {
      const [lo, hi] = range;
      return clamp(v, lo, hi);
    }
    return undefined;
  };
  return {
    dailyMaxTimes:
      pick("dailyMaxTimes", w.dailyMaxTimesRange) ?? w.dailyMaxTimesDefault,
    feeRate: pick("feeRate", w.feeRateRange) ?? w.feeRateDefault,
    feeMinAbsolute: w.feeMinAbsolute,
    tenureHours:
      pick("tenureHours", w.tenureHoursRange) ?? w.tenureHoursDefault,
    minContribution:
      pick("minContribution", w.minContributionRange) ?? w.minContributionDefault,
  };
};

const calcFee = (itemId, qty, club) => {
  const def = itemDef(itemId);
  if (!def) return 0;
  const settings = resolveSettings(club);
  const raw = def.unitPrice * qty * settings.feeRate;
  return Math.max(settings.feeMinAbsolute, Math.ceil(raw));
};

const marketValue = (itemId, qty) => {
  const def = itemDef(itemId);
  if (!def) return 0;
  return def.unitPrice * qty;
};

const contributionFromDeposit = (itemId, qty) =>
  Math.floor(marketValue(itemId, qty) * (guildWarehouse.depositContributionRate || 0));

module.exports = {
  dayKeyOf,
  itemDef,
  allItemIds,
  capacityFor,
  perTakeMaxFor,
  resolveSettings,
  calcFee,
  marketValue,
  contributionFromDeposit,
};
