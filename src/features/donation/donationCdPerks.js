const { donation } = require("../../config");

// 贊助身分組的冷卻固定減免（VIP 優先，取單一最高檔，不與一般贊助疊加）。
// 挖礦 / 釣魚共用同一份判定，避免兩邊各寫一份規則而其中一份漏更新。
const CFG_KEY = { mine: "miningCdReductionMs", fish: "fishingCdReductionMs" };

function donationCdMs(kind, member) {
  if (!member?.roles?.cache) return 0;
  const cfg = donation?.[CFG_KEY[kind]] || {};
  const ids = donation?.roleIds || {};
  if (ids.vipDonor && member.roles.cache.has(ids.vipDonor)) return cfg.vipDonor || 0;
  if (ids.donor && member.roles.cache.has(ids.donor)) return cfg.donor || 0;
  return 0;
}

module.exports = { donationCdMs };
