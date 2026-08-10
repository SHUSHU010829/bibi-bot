const { donation, boosterPerks } = require("../../config");

// 身分組類的冷卻固定減免（贊助身分組 + 伺服器加成）。
// 挖礦 / 釣魚共用同一份判定，避免兩邊各寫一份規則而其中一份漏更新。
const CFG_KEY = { mine: "miningCdReductionMs", fish: "fishingCdReductionMs" };

// 贊助：VIP 優先，取單一最高檔，不與一般贊助疊加。
function donationCdMs(kind, member) {
  if (!member?.roles?.cache) return 0;
  const cfg = donation?.[CFG_KEY[kind]] || {};
  const ids = donation?.roleIds || {};
  if (ids.vipDonor && member.roles.cache.has(ids.vipDonor)) return cfg.vipDonor || 0;
  if (ids.donor && member.roles.cache.has(ids.donor)) return cfg.donor || 0;
  return 0;
}

// 伺服器加成（Booster）：單一身分組，與贊助各自獨立、可疊加。
function boosterCdMs(kind, member) {
  if (!boosterPerks?.enabled || !boosterPerks?.roleId) return 0;
  if (!member?.roles?.cache?.has(boosterPerks.roleId)) return 0;
  return boosterPerks[CFG_KEY[kind]] || 0;
}

const roleCdMs = (kind, member) => donationCdMs(kind, member) + boosterCdMs(kind, member);

module.exports = { donationCdMs, boosterCdMs, roleCdMs };
