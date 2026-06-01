const userSettings = require("../features/settings/userSettings");

/**
 * GET /api/v1/u/:userId?guildId=
 *
 * 公開玩家資料卡片資料來源。
 *
 * 規則：
 *   1. 必須帶 guildId
 *   2. 玩家必須在 UserSettings.publicProfile = true（隱私優先）
 *      否則回 404 not_public
 *   3. 玩家必須仍在 guild 內，否則 404 not_a_member
 *
 * 回傳的欄位是「適合公開展示」的子集，不含金幣餘額、近 30 天 net 這種
 * 偏向私人/敏感的數據。
 */
module.exports = function createPublicProfileHandler(client) {
  return async function (req, res) {
    const targetId = String(req.params.userId || "");
    const guildId = String(req.query.guildId || "");
    if (!/^\d{15,20}$/.test(targetId)) {
      return res.status(400).json({ error: "invalid userId" });
    }
    if (!guildId) {
      return res.status(400).json({ error: "missing guildId" });
    }

    const settings = await userSettings.get(client, targetId, guildId);
    if (!settings.publicProfile) {
      return res.status(404).json({ error: "not_public" });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(503).json({ error: "guild not in cache" });
    }
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) return res.status(404).json({ error: "not_a_member" });

    const [coin, level, mining, titlesDoc] = await Promise.all([
      client.userCoinsCollection
        ?.findOne({ userId: targetId, guildId })
        .catch(() => null),
      client.userLevelsCollection
        ?.findOne({ userId: targetId, guildId })
        .catch(() => null),
      client.miningProfilesCollection
        ?.findOne({ userId: targetId, guildId })
        .catch(() => null),
      client.userLevelsCollection
        ?.findOne(
          { userId: targetId, guildId },
          { projection: { gameTitles: 1, equippedTitle: 1 } },
        )
        .catch(() => null),
    ]);

    res.json({
      ok: true,
      user: {
        userId: targetId,
        username: member.user.username,
        globalName: member.user.globalName,
        displayName: member.displayName,
        avatar: member.user.displayAvatarURL({ size: 256 }),
        bannerColor: member.user.accentColor,
        joinedAt: member.joinedAt,
      },
      level: {
        level: level?.level ?? 0,
        totalXp: level?.totalXp ?? 0,
        streak: level?.streak ?? 0,
        longestStreak: level?.longestStreak ?? 0,
        totalCheckins: level?.totalCheckins ?? 0,
        totalMessages: level?.totalMessages ?? 0,
        totalVoiceMinutes: level?.totalVoiceMinutes ?? 0,
      },
      coin: {
        lifetime: coin?.lifetimeCoins ?? 0,
      },
      mining: {
        mineCount: mining?.mine_count_total ?? 0,
        fishCount: mining?.fish_count_total ?? 0,
        workCount: mining?.work_count_total ?? 0,
        dungeonCount: mining?.dungeon_count ?? 0,
        craftCount: mining?.craft_count_total ?? 0,
        lifetimeOre: mining?.lifetime_ore ?? {},
        fishBag: mining?.fish_bag ?? {},
      },
      titles: {
        equipped: titlesDoc?.equippedTitle ?? null,
        unlocked: Array.isArray(titlesDoc?.gameTitles)
          ? titlesDoc.gameTitles
          : [],
        count: Array.isArray(titlesDoc?.gameTitles)
          ? titlesDoc.gameTitles.length
          : 0,
      },
    });
  };
};
