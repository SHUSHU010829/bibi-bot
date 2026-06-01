const { coinsForAmount, roleName } = require("./code");

const ITEM_NAMES = {
  luck_potion: "幸運藥水",
  cd_ticket: "CD 縮短券",
};

/** 整理供 website success 頁 / admin 後台顯示的權益摘要（字串清單） */
function computePerksSummary(tier, amountNtd) {
  if (!tier) return null;
  const list = [];
  const coins = amountNtd != null ? coinsForAmount(amountNtd) : tier.coins;
  if (coins) list.push(`${coins.toLocaleString()} 金幣`);
  if (tier.items) {
    for (const [itemId, qty] of Object.entries(tier.items)) {
      if (!qty) continue;
      list.push(`${ITEM_NAMES[itemId] || itemId} ×${qty}`);
    }
  }
  if (tier.role) {
    const dur =
      tier.permanentRole || tier.roleDurationDays === null
        ? "永久"
        : `${tier.roleDurationDays} 天`;
    list.push(`${roleName(tier)}身分組（${dur}）`);
  }
  if (tier.luckBonus && tier.luckBonus > 0) {
    const dur =
      tier.luckDurationDays === null ? "永久" : `${tier.luckDurationDays} 天`;
    list.push(`挖礦 luck +${Math.round(tier.luckBonus * 100)}%（${dur}）`);
  }
  if (tier.themeId) {
    list.push(`限定卡面（${tier.themePermanent ? "永久" : "限時"}）`);
  }
  if (tier.titleId) {
    const dur = tier.titleDurationDays ? `${tier.titleDurationDays} 天` : "永久";
    list.push(`自訂稱號（${dur}）`);
  }
  if (tier.canNominateTitle) list.push("可提名限定稱號");
  return list;
}

module.exports = { computePerksSummary };
