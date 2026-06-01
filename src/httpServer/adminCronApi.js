const express = require("express");
const logger = require("../utils/logger");
const requireAdmin = require("./middleware/requireAdmin");
const withAudit = require("./middleware/withAudit");
const { listJobs, getJob, runJobNow } = require("../utils/cronRegistry");

module.exports = function createAdminCronRouter(client) {
  const router = express.Router();
  router.use(requireAdmin(client));

  // GET /api/v1/admin/cron/jobs — 列出所有已註冊任務 + 最近一次紀錄
  router.get("/jobs", async (_req, res, next) => {
    try {
      const jobs = listJobs();
      const col = client.cronJobLogCollection;

      const enriched = await Promise.all(
        jobs.map(async (j) => {
          if (!col) return { ...j, lastRun: null };
          const last = await col
            .find({ name: j.name })
            .sort({ startedAt: -1 })
            .limit(1)
            .next()
            .catch(() => null);
          return {
            ...j,
            lastRun: last
              ? {
                  startedAt: last.startedAt,
                  finishedAt: last.finishedAt || null,
                  status: last.status,
                  durationMs: last.durationMs || null,
                  trigger: last.trigger || null,
                  error: last.error || null,
                }
              : null,
          };
        }),
      );

      res.json({ ok: true, jobs: enriched });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/cron/jobs/:name/runs?limit=50
  router.get("/jobs/:name/runs", async (req, res, next) => {
    try {
      const col = client.cronJobLogCollection;
      if (!col) return res.status(503).json({ error: "db not ready" });
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const rows = await col
        .find({ name: req.params.name })
        .sort({ startedAt: -1 })
        .limit(limit)
        .toArray();
      res.json({
        ok: true,
        name: req.params.name,
        registered: Boolean(getJob(req.params.name)),
        rows,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/cron/jobs/:name/run  — Owner only
  router.post(
    "/jobs/:name/run",
    withAudit(client, "cron.run", (req) => ({
      targetId: req.params.name,
      payload: null,
      reason: "manual trigger",
    })),
    async (req, res, next) => {
      try {
        if (!req.admin.isOwner) {
          return res.status(403).json({ error: "owner only" });
        }
        const result = await runJobNow(client, req.params.name);
        if (!result.ok) {
          if (result.error === "job not registered") {
            return res.status(404).json({ error: result.error });
          }
          return res.status(500).json({
            ok: false,
            error: String(result.error?.message || result.error),
          });
        }
        logger.info(
          { source: "admin-cron", adminId: req.admin.userId, name: req.params.name },
          "cron manual run",
        );
        res.json({ ok: true, result: result.result ?? null });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
};
