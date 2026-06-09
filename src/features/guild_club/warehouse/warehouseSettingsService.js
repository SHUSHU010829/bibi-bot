const { guildWarehouse } = require("../../../config");
const guildClubService = require("../guildClubService");

const SETTING_KEYS = [
  "dailyMaxTimes",
  "feeRate",
  "tenureHours",
  "minContribution",
];

const cfgRange = (key) => {
  const w = guildWarehouse?.withdraw || {};
  const map = {
    dailyMaxTimes: { range: w.dailyMaxTimesRange, default: w.dailyMaxTimesDefault, kind: "int" },
    feeRate: { range: w.feeRateRange, default: w.feeRateDefault, kind: "rate" },
    tenureHours: { range: w.tenureHoursRange, default: w.tenureHoursDefault, kind: "int" },
    minContribution: { range: w.minContributionRange, default: w.minContributionDefault, kind: "int" },
  };
  return map[key];
};

const parseInput = (key, rawStr) => {
  const cfg = cfgRange(key);
  if (!cfg) return { ok: false, reason: "unknown_key" };
  const s = (rawStr || "").trim();
  if (!s) return { ok: true, clear: true };
  if (cfg.kind === "rate") {
    let v;
    if (s.endsWith("%")) v = parseFloat(s.slice(0, -1)) / 100;
    else v = parseFloat(s);
    if (!Number.isFinite(v)) return { ok: false, reason: "not_number" };
    const [lo, hi] = cfg.range;
    if (v < lo || v > hi)
      return { ok: false, reason: "out_of_range", lo, hi, kind: cfg.kind };
    return { ok: true, value: v };
  }
  const v = parseInt(s, 10);
  if (!Number.isInteger(v))
    return { ok: false, reason: "not_integer" };
  const [lo, hi] = cfg.range;
  if (v < lo || v > hi)
    return { ok: false, reason: "out_of_range", lo, hi, kind: cfg.kind };
  return { ok: true, value: v };
};

const updateSettings = async (
  client,
  { userId, guildId, inputs }
) => {
  const m = await guildClubService.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(m.role))
    return { ok: false, reason: "not_manager" };

  const club = await guildClubService.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const set = {};
  const unset = {};
  const errors = [];
  const applied = {};

  for (const key of SETTING_KEYS) {
    const raw = inputs[key];
    if (raw === undefined) continue;
    const parsed = parseInput(key, raw);
    if (!parsed.ok) {
      errors.push({ key, ...parsed });
      continue;
    }
    if (parsed.clear) {
      unset[`warehouse_settings.${key}`] = "";
      applied[key] = null;
    } else {
      set[`warehouse_settings.${key}`] = parsed.value;
      applied[key] = parsed.value;
    }
  }

  if (errors.length > 0) return { ok: false, reason: "validation_failed", errors };

  const update = {};
  if (Object.keys(set).length) update.$set = { ...set, updated_at: new Date() };
  if (Object.keys(unset).length) update.$unset = unset;
  if (Object.keys(update).length === 0)
    return { ok: false, reason: "no_change" };

  await client.guildsClubCollection.updateOne(
    { guild_club_id: m.guild_club_id, disbanded_at: null },
    update
  );

  const after = await guildClubService.getClubById(client, m.guild_club_id);
  return { ok: true, club: after, applied };
};

const updatePerTakeMax = async (
  client,
  { userId, guildId, inputs }
) => {
  const m = await guildClubService.getMembership(client, userId, guildId);
  if (!m) return { ok: false, reason: "not_in_club" };
  if (!guildClubService.isManager(m.role))
    return { ok: false, reason: "not_manager" };

  const club = await guildClubService.getClubById(client, m.guild_club_id);
  if (!club) return { ok: false, reason: "club_missing" };

  const items = guildWarehouse?.items || {};
  const set = {};
  const unset = {};
  const errors = [];
  const applied = {};

  for (const [itemId, raw] of Object.entries(inputs || {})) {
    const def = items[itemId];
    if (!def) continue;
    const s = (raw || "").trim();
    if (!s) {
      unset[`warehouse_settings.perTakeMax.${itemId}`] = "";
      applied[itemId] = null;
      continue;
    }
    const v = parseInt(s, 10);
    if (!Number.isInteger(v)) {
      errors.push({ itemId, reason: "not_integer" });
      continue;
    }
    const [lo, hi] = def.perTakeMaxRange;
    if (v < lo || v > hi) {
      errors.push({ itemId, reason: "out_of_range", lo, hi });
      continue;
    }
    set[`warehouse_settings.perTakeMax.${itemId}`] = v;
    applied[itemId] = v;
  }

  if (errors.length > 0) return { ok: false, reason: "validation_failed", errors };

  const update = {};
  if (Object.keys(set).length) update.$set = { ...set, updated_at: new Date() };
  if (Object.keys(unset).length) update.$unset = unset;
  if (Object.keys(update).length === 0)
    return { ok: false, reason: "no_change" };

  await client.guildsClubCollection.updateOne(
    { guild_club_id: m.guild_club_id, disbanded_at: null },
    update
  );

  const after = await guildClubService.getClubById(client, m.guild_club_id);
  return { ok: true, club: after, applied };
};

module.exports = {
  SETTING_KEYS,
  cfgRange,
  parseInput,
  updateSettings,
  updatePerTakeMax,
};
