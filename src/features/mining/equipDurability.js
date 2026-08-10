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
    bonusField: "pickaxe_max_durability_bonus",
    defs: () => mining?.pickaxes || {},
  },
  weapon: {
    label: "武器", emoji: "⚔️", none: "fist", reason: "no_weapon",
    idField: "weapon", maxField: "weapon_max_durability", duraField: "weapon_durability",
    bonusField: "weapon_max_durability_bonus",
    defs: () => dungeon?.weapons || {},
  },
  shield: {
    label: "盾牌", emoji: "🛡️", none: null, reason: "no_shield",
    idField: "shield", maxField: "shield_max_durability", duraField: "shield_durability",
    bonusField: "shield_max_durability_bonus",
    defs: () => dungeon?.shields || {},
  },
  rod: {
    label: "釣竿", emoji: "🪝", none: "bamboo", reason: "no_rod",
    idField: "fishing_rod", maxField: "rod_max_durability", duraField: "rod_durability",
    bonusField: "rod_max_durability_bonus",
    defs: () => fishing?.rods || {},
  },
};

// 上限拆成兩個欄位，兩者的意義與生命週期完全不同：
//   *_max_durability       = 該裝備 config 的原始上限，打造 / 購買時覆蓋，之後不再變動。
//   *_max_durability_bonus = 維修工具 maxDelta 與劣質磨石 -10 的累計值，可正可負，
//                            升級換裝備時「不」重設，所以傳說維修工具的 +2 能一路帶著走。
// 有效上限 = floor(base ×(1+鐵匠鋪%)) + bonus：鐵匠鋪只加成裝備本身的原始耐久，
// 不對維修工具補上來的部分再乘一次。
const MIN_BASE_WITH_BONUS = 10;

const bonusOf = (profile, slot) => {
  const spec = EQUIP_SLOTS[slot];
  if (!spec) return 0;
  const v = profile?.[spec.bonusField];
  return typeof v === "number" ? v : 0;
};

// 未吃鐵匠鋪加成的上限（base + bonus）。所有「不得低於 10 / 低於 20 不給用」這類
// 門檻判定都用這個值，跟公會狀態無關。
const baseWithBonus = (profile, slot) => {
  const spec = EQUIP_SLOTS[slot];
  if (!spec) return null;
  const base = profile?.[spec.maxField];
  if (typeof base !== "number") return null;
  return base + bonusOf(profile, slot);
};

const effectiveMaxOf = (profile, slot, pct) => {
  const spec = EQUIP_SLOTS[slot];
  if (!spec) return null;
  const base = profile?.[spec.maxField];
  if (typeof base !== "number") return base ?? null;
  return buildingService.effectiveMaxDurability(base, pct) + bonusOf(profile, slot);
};

// 預覽「bonus 變動 delta 之後」的有效上限，給維修工具 / 磨石的確認畫面與結果訊息用。
const effectiveMaxWithBonusDelta = (profile, slot, pct, delta) => {
  const eff = effectiveMaxOf(profile, slot, pct);
  return typeof eff === "number" ? eff + delta : eff;
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

// 顯示用：耐久後面補一句 bonus 來源，讓玩家看得出「為什麼跟圖鑑寫的不一樣」。
const bonusSuffix = (profile, slot) => {
  const bonus = bonusOf(profile, slot);
  if (!bonus) return "";
  return bonus > 0 ? `（含維修工具 +${bonus}）` : `（含磨損 ${bonus}）`;
};

module.exports = {
  EQUIP_SLOTS,
  MIN_BASE_WITH_BONUS,
  bonusOf,
  baseWithBonus,
  bonusSuffix,
  effectiveMaxOf,
  effectiveMaxWithBonusDelta,
  effectiveMaxes,
  equipMaxPct,
  slotEquipped,
};
