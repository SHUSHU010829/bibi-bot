require("colors");
const { mining, dungeon, fishing } = require("../../config");
const buildingService = require("../guild_club/buildingService");

// 四種有耐久的裝備欄位。none = 「等於沒裝」的哨兵值（盾沒有預設款，用 null）。
// 只有這份是唯一來源：修復、磨石、維修工具、各種畫面都從這裡取欄位名與有效上限，
// 避免某條路徑漏吃鐵匠鋪加成而算出跟畫面不一致的數字。
const EQUIP_SLOTS = {
  pickaxe: {
    label: "鎬子", emoji: "⛏️", none: "wood", reason: "no_pickaxe",
    idField: "pickaxe", maxField: "pickaxe_max_durability", duraField: "pickaxe_durability",
    defs: () => mining?.pickaxes || {},
  },
  weapon: {
    label: "武器", emoji: "⚔️", none: "fist", reason: "no_weapon",
    idField: "weapon", maxField: "weapon_max_durability", duraField: "weapon_durability",
    defs: () => dungeon?.weapons || {},
  },
  shield: {
    label: "盾牌", emoji: "🛡️", none: null, reason: "no_shield",
    idField: "shield", maxField: "shield_max_durability", duraField: "shield_durability",
    defs: () => dungeon?.shields || {},
  },
  rod: {
    label: "釣竿", emoji: "🪝", none: "bamboo", reason: "no_rod",
    idField: "fishing_rod", maxField: "rod_max_durability", duraField: "rod_durability",
    defs: () => fishing?.rods || {},
  },
};

// DB 的 *_max_durability 一律只存原始 base；有效上限 = base ×(1+鐵匠鋪%)，讀 / 補滿時才算。
const effectiveMaxOf = (profile, slot, pct) => {
  const spec = EQUIP_SLOTS[slot];
  if (!spec) return null;
  return buildingService.effectiveMaxDurability(profile?.[spec.maxField], pct);
};

const equipMaxPct = (client, userId, guildId) =>
  buildingService.getEquipmentMaxDurabilityPct(client, userId, guildId);

// 一次算好四件裝備的有效上限，給要同時顯示多欄位的畫面用。
async function effectiveMaxes(client, { userId, guildId, profile }) {
  const pct = await equipMaxPct(client, userId, guildId);
  const out = { pct };
  for (const slot of Object.keys(EQUIP_SLOTS)) out[slot] = effectiveMaxOf(profile, slot, pct);
  return out;
}

const slotEquipped = (profile, slot) => {
  const spec = EQUIP_SLOTS[slot];
  if (!spec) return false;
  const id = profile?.[spec.idField];
  if (!id || id === spec.none) return false;
  return typeof profile?.[spec.maxField] === "number";
};

module.exports = {
  EQUIP_SLOTS,
  effectiveMaxOf,
  effectiveMaxes,
  equipMaxPct,
  slotEquipped,
};
