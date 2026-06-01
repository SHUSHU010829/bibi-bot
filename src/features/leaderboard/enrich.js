/**
 * 把 leaderboard row 加上 displayName / avatar，給公開 dashboard 用。
 *
 * 用 Discord guild member cache（不會主動 fetch，避免一次拉幾百人）。
 * 找不到 member 的填佔位資料，前端就顯示「未知玩家」即可。
 *
 * 未來 B-Step 2 引入 UserSettings.public_profile 後，這裡會額外查詢並把
 * 沒開啟公開的玩家匿名化。目前先不做。
 */
function enrichLeaderboardRows(client, guildId, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return rows.map((r) => ({ ...r, displayName: null, avatar: null }));
  }
  return rows.map((r) => {
    const member = guild.members.cache.get(r.userId);
    if (!member) {
      return { ...r, displayName: null, avatar: null };
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
