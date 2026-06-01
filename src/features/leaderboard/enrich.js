const userSettings = require("../settings/userSettings");

/**
 * 把 leaderboard row 加上 displayName / avatar，給公開 dashboard 用。
 *
 * 規則：
 *   1. 用 Discord guild member cache 取 displayName / avatar（不主動 fetch）
 *   2. 查 UserSettings.publicProfile，沒開啟的人匿名化（顯示「匿名玩家」+ null avatar）
 *   3. cache 找不到的 member 也顯示「未知玩家」
 *
 * 數值欄位（total / value / count / titleCount...）一律保留，
 * 不會因為匿名化就抹掉名次，只是隱藏身份。
 */
async function enrichLeaderboardRows(client, guildId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const guild = client.guilds.cache.get(guildId);
  const userIds = rows.map((r) => r.userId);
  const publicSet = await userSettings.getPublicUserIds(
    client,
    guildId,
    userIds,
  );

  return rows.map((r) => {
    const isPublic = publicSet.has(r.userId);
    if (!isPublic) {
      return {
        ...r,
        userId: r.userId,
        displayName: null,
        username: null,
        avatar: null,
        anonymous: true,
      };
    }
    const member = guild?.members.cache.get(r.userId);
    if (!member) {
      return { ...r, displayName: null, username: null, avatar: null };
    }
    return {
      ...r,
      displayName: member.displayName,
      username: member.user.username,
      avatar: member.user.displayAvatarURL({ size: 64 }),
    };
  });
}

module.exports = { enrichLeaderboardRows };
