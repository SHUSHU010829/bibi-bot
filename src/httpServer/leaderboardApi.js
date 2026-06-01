const express = require("express");
const miningLeaderboard = require("../features/leaderboard/miningLeaderboard");
const titleLeaderboard = require("../features/leaderboard/titleLeaderboard");
const weeklySummary = require("../features/leaderboard/weeklySummary");
const { enrichLeaderboardRows } = require("../features/leaderboard/enrich");

const VALID_PERIODS = ["today", "week", "month", "all"];

// 供 Dashboard（bibi-website）讀取的排行榜 API。
// 所有端點都需要 ?guildId=<id>。
module.exports = function createLeaderboardRouter(client) {
  const router = express.Router();

  function requireGuild(req, res) {
    const guildId = req.query.guildId;
    if (!guildId) {
      res.status(400).json({ error: "missing guildId" });
      return null;
    }
    return String(guildId);
  }

  // GET /api/v1/leaderboard/mining?type=count|value|diamond&period=week&limit=10
  router.get("/mining", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      const type = req.query.type || "count";
      const limit = Math.min(Number(req.query.limit) || 10, 100);
      let period = req.query.period || "week";
      if (!VALID_PERIODS.includes(period)) period = "week";

      let rows;
      if (type === "value") {
        rows = await miningLeaderboard.byValue(client, guildId, period, limit);
      } else if (type === "diamond") {
        rows = await miningLeaderboard.byDiamond(client, guildId, limit);
        period = "all";
      } else {
        rows = await miningLeaderboard.byCount(client, guildId, period, limit);
      }
      res.json({
        ok: true,
        type,
        period,
        rows: await enrichLeaderboardRows(client, guildId, rows),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/leaderboard/titles?guildId=&limit=
  router.get("/titles", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      const limit = Math.min(Number(req.query.limit) || 10, 100);
      const rows = await titleLeaderboard.topByTitleCount(client, guildId, limit);
      res.json({
        ok: true,
        rows: await enrichLeaderboardRows(client, guildId, rows),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/leaderboard/weekly-summary?guildId=&top=3
  router.get("/weekly-summary", async (req, res, next) => {
    try {
      const guildId = requireGuild(req, res);
      if (!guildId) return;
      const top = Math.min(Number(req.query.top) || 3, 25);
      const data = await weeklySummary.data(client, guildId, top);
      const [mining, value, titles] = await Promise.all([
        enrichLeaderboardRows(client, guildId, data.mining),
        enrichLeaderboardRows(client, guildId, data.value),
        enrichLeaderboardRows(client, guildId, data.titles),
      ]);
      res.json({
        ok: true,
        mining,
        value,
        titles,
        resetEpoch: data.resetEpoch,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
