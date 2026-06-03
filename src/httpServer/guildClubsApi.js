const express = require("express");
const guildClubQuest = require("../features/guild_club/guildClubQuest");

// 公開公會排行 API（Dashboard / 公開頁面讀取）。
// 不需要 auth；資料皆為各伺服器內公會的彙整資料。
module.exports = function createGuildClubsRouter(client) {
  const router = express.Router();

  function requireGuild(req, res) {
    const guildId = req.query.guildId;
    if (!guildId) {
      res.status(400).json({ error: "missing guildId" });
      return null;
    }
    return String(guildId);
  }

  // GET /api/v1/guild_clubs/leaderboard?guildId=&limit=
  router.get("/leaderboard", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      const limit = Math.min(Number(req.query.limit) || 25, 100);
      const clubs = await guildClubQuest.getLeaderboard(client, {
        guildId,
        limit,
      });
      res.json({
        ok: true,
        rows: clubs.map((c) => ({
          guildClubId: c.guild_club_id,
          name: c.name,
          level: c.level,
          treasury: c.treasury || 0,
          treasuryCurrent: c.treasury_current || 0,
          memberCount: c.member_count,
          maxMembers: c.max_members,
          createdAt: c.created_at,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
