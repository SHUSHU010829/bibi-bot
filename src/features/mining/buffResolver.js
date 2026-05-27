const { mining } = require("../../config");

// 整合鎬子 / 幸運藥水 / CD 縮短券（Twitch tier 加成預留，Phase 7 再接）。
// 回傳 { luckBonus, qtyBonus, actualCdMs, consume: { usePotion, useTicket } }。
function resolve(profile, member, opts = {}) {
  const pickaxes = mining?.pickaxes || {};
  const pdef = pickaxes[profile?.pickaxe] || pickaxes.wood || {};

  let luckBonus = pdef.luckBonus || 0;
  const qtyBonus = pdef.qtyBonus || 0;
  let cdMs = (mining?.cooldownMs || 0) - (pdef.cdReductionMs || 0);

  // 幸運藥水：持有次數 > 0 時自動生效並消耗一次
  const usePotion = (profile?.luck_potion_uses || 0) > 0;
  if (usePotion) luckBonus += mining?.luckPotionBonus || 0;

  // CD 縮短券：由指令選項決定是否使用（避免每次自動燒券）
  const useTicket = opts.useTicket === true && (profile?.cd_ticket_count || 0) > 0;
  if (useTicket) cdMs -= mining?.cdTicketReductionMs || 0;

  // TODO(Phase 7): Twitch tier 挖礦 luck / CD 加成（沿用 coinMultiplier 角色 ID）

  // luck 全域上限
  const cap = mining?.luckCap ?? 0.25;
  if (luckBonus > cap) luckBonus = cap;

  // CD 下限保護（避免負數 / 零）
  const actualCdMs = Math.max(cdMs, 60 * 1000);

  return { luckBonus, qtyBonus, actualCdMs, consume: { usePotion, useTicket } };
}

module.exports = { resolve };
