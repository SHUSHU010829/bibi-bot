const { twitchPerks, twitchSync } = require("../../config");

// tier → 角色 ID 對照沿用 level.json 的 twitchSync.tierRoleIds（與訂閱倍率同一組角色）。
function tierRoleIds() {
  return twitchSync?.tierRoleIds || {};
}

// 回傳 member 對應「最高」tier 的權益（含 tierKey）。非訂閱者或未啟用回 null。
function resolvePerks(member) {
  if (!twitchPerks?.enabled) return null;
  if (!member?.roles?.cache) return null;

  const roleIds = tierRoleIds();
  const tiers = twitchPerks?.tiers || {};
  for (const key of ["tier3", "tier2", "tier1"]) {
    const rid = roleIds[key];
    if (rid && member.roles.cache.has(rid) && tiers[key]) {
      return { tierKey: key, ...tiers[key] };
    }
  }
  return null;
}

module.exports = { resolvePerks, tierRoleIds };
