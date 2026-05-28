const { mining } = require("../../config");
const twitchPerks = require("./twitchPerks");

// 整合鎬子 / 幸運藥水 / Twitch 訂閱者權益。
// CD 縮短券改為冷卻中於 /背包 主動使用（見 mineService.useCdTicket），不在挖礦時自動消耗。
// 回傳 { luckBonus, qtyBonus, actualCdMs, consume: { usePotion } }。
function resolve(profile, member) {
  const pickaxes = mining?.pickaxes || {};
  const pdef = pickaxes[profile?.pickaxe] || pickaxes.wood || {};

  let luckBonus = pdef.luckBonus || 0;
  const qtyBonus = pdef.qtyBonus || 0;
  let cdMs = (mining?.cooldownMs || 0) - (pdef.cdReductionMs || 0);

  // 幸運藥水：持有次數 > 0 時自動生效並消耗一次
  const usePotion = (profile?.luck_potion_uses || 0) > 0;
  if (usePotion) luckBonus += mining?.luckPotionBonus || 0;

  // Twitch 訂閱者權益：依 tier 加挖礦 luck、縮短 CD（沿用訂閱角色 ID）
  const perks = twitchPerks.resolvePerks(member);
  if (perks) {
    luckBonus += perks.miningLuckBonus || 0;
    cdMs -= perks.miningCdReductionMs || 0;
  }

  // 抖內 luck buff（永久 expiresAt=null，限時則需 > now）
  const donationLuckBonus = Number(profile?.donation_luck_bonus || 0);
  if (donationLuckBonus > 0) {
    const exp = profile?.donation_luck_expires_at;
    const stillValid = !exp || new Date(exp).getTime() > Date.now();
    if (stillValid) luckBonus += donationLuckBonus;
  }

  // luck 全域上限
  const cap = mining?.luckCap ?? 0.25;
  if (luckBonus > cap) luckBonus = cap;

  // CD 下限保護（避免負數 / 零）
  const actualCdMs = Math.max(cdMs, 60 * 1000);

  return { luckBonus, qtyBonus, actualCdMs, consume: { usePotion } };
}

module.exports = { resolve };
