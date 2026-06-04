const express = require("express");
const requireAdmin = require("./middleware/requireAdmin");
const {
  aggregateFlow,
  getTopHolders,
  getCirculationNow,
  getRecentSnapshots,
  todayIso,
  isoDaysAgo,
  classifySource,
} = require("../features/economy/economyDashboard");

function clampDays(raw, fallback = 7, max = 90) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

module.exports = function createAdminEconomyRouter(client) {
  const router = express.Router();
  router.use(requireAdmin(client));

  // GET /api/v1/admin/economy/overview
  // 一次回流通量 + 7d 彙總 + Top10 集中度，給 dashboard 首頁卡片
  router.get("/overview", async (req, res, next) => {
    try {
      const guildId = req.admin.guildId;
      const days = clampDays(req.query.days, 7);
      const fromIso = isoDaysAgo(days - 1);
      const toIso = todayIso();
      const [circulation, flow, holders, snapshots] = await Promise.all([
        getCirculationNow(client, guildId),
        aggregateFlow(client, guildId, fromIso, toIso),
        getTopHolders(client, guildId, 10),
        getRecentSnapshots(client, guildId, Math.max(days, 30)),
      ]);
      res.json({
        ok: true,
        guildId,
        range: { days, fromIso, toIso },
        circulation,
        totals: flow.totals,
        topHolders: {
          top10Coins: holders.top10Coins,
          top10Share: holders.top10Share,
        },
        snapshots: snapshots.map((s) => ({
          date: s.date,
          totalCirculation: s.totalCirculation,
          totalWalletCoins: s.totalWalletCoins,
          totalDepositPrincipal: s.totalDepositPrincipal,
          activeUsers: s.activeUsers,
          flow: s.flow || null,
          concentration: s.concentration || null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/economy/flow?days=30
  // 每日 minted / burned / netFlow，給趨勢圖
  router.get("/flow", async (req, res, next) => {
    try {
      const guildId = req.admin.guildId;
      const days = clampDays(req.query.days, 30);
      const fromIso = isoDaysAgo(days - 1);
      const toIso = todayIso();
      const flow = await aggregateFlow(client, guildId, fromIso, toIso);
      res.json({
        ok: true,
        guildId,
        range: { days, fromIso, toIso },
        days: flow.days.map((d) => ({
          date: d.date,
          mintedTotal: d.mintedTotal,
          burnedTotal: d.burnedTotal,
          netFlow: d.netFlow,
        })),
        totals: flow.totals,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/economy/sources?days=7
  // source 拆解（含分類：mint / sink / peer）
  router.get("/sources", async (req, res, next) => {
    try {
      const guildId = req.admin.guildId;
      const days = clampDays(req.query.days, 7);
      const fromIso = isoDaysAgo(days - 1);
      const toIso = todayIso();
      const { totals } = await aggregateFlow(client, guildId, fromIso, toIso);
      const allSources = new Set([
        ...Object.keys(totals.mintedBySource),
        ...Object.keys(totals.burnedBySource),
      ]);
      const sources = [...allSources]
        .map((s) => {
          const minted = totals.mintedBySource[s] || 0;
          const burned = totals.burnedBySource[s] || 0;
          return {
            source: s,
            classification: classifySource(s),
            minted,
            burned,
            net: minted - burned,
          };
        })
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      res.json({
        ok: true,
        guildId,
        range: { days, fromIso, toIso },
        sources,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/economy/top-holders?limit=20
  router.get("/top-holders", async (req, res, next) => {
    try {
      const guildId = req.admin.guildId;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
      const holders = await getTopHolders(client, guildId, limit);
      res.json({
        ok: true,
        guildId,
        totalWalletCoins: holders.totalWalletCoins,
        top10Share: holders.top10Share,
        top10Coins: holders.top10Coins,
        rows: holders.rows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
