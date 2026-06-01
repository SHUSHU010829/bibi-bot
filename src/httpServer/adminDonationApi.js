const express = require("express");
const { ObjectId } = require("mongodb");
const logger = require("../utils/logger");
const requireAdmin = require("./middleware/requireAdmin");
const withAudit = require("./middleware/withAudit");
const { tierForAmount } = require("../features/donation/code");
const { computePerksSummary } = require("../features/donation/perksSummary");
const grantDonationPerks = require("../features/donation/grantDonationPerks");

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parsePagination(req) {
  const page = Math.max(0, Number(req.query.page) || 0);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE),
  );
  return { page, pageSize };
}

module.exports = function createAdminDonationRouter(client) {
  const router = express.Router();

  router.use(requireAdmin(client));

  // GET /api/v1/admin/donation/records
  router.get("/records", async (req, res, next) => {
    try {
      const records = client.donationRecordsCollection;
      if (!records) return res.status(503).json({ error: "db not ready" });

      const filter = {};
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      if (from || to) {
        filter.grantedAt = {};
        if (from) filter.grantedAt.$gte = from;
        if (to) filter.grantedAt.$lte = to;
      }
      if (req.query.platform === "ecpay" || req.query.platform === "opay") {
        filter.platform = req.query.platform;
      }
      if (req.query.granted === "true") filter.coinsGranted = true;
      else if (req.query.granted === "false") filter.coinsGranted = { $ne: true };

      const { page, pageSize } = parsePagination(req);
      const [rows, total] = await Promise.all([
        records
          .find(filter)
          .sort({ grantedAt: -1 })
          .skip(page * pageSize)
          .limit(pageSize)
          .toArray(),
        records.countDocuments(filter),
      ]);

      res.json({ ok: true, page, pageSize, total, rows });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/donation/unmatched
  router.get("/unmatched", async (req, res, next) => {
    try {
      const unmatched = client.unmatchedDonationsCollection;
      if (!unmatched) return res.status(503).json({ error: "db not ready" });

      const filter = {};
      if (req.query.status === "pending") filter.resolved = false;
      else if (req.query.status === "resolved") filter.resolved = true;

      const { page, pageSize } = parsePagination(req);
      const [rows, total] = await Promise.all([
        unmatched
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(page * pageSize)
          .limit(pageSize)
          .toArray(),
        unmatched.countDocuments(filter),
      ]);

      res.json({ ok: true, page, pageSize, total, rows });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/donation/unmatched/:id/resolve
  // Body: { userId, reason }
  router.post(
    "/unmatched/:id/resolve",
    withAudit(client, "donation.unmatched.resolve", (req) => ({
      targetId: req.params.id,
      payload: { grantUserId: req.body?.userId },
      reason: req.body?.reason,
    })),
    async (req, res, next) => {
      try {
        const unmatched = client.unmatchedDonationsCollection;
        const records = client.donationRecordsCollection;
        if (!unmatched || !records) {
          return res.status(503).json({ error: "db not ready" });
        }

        const targetUserId =
          typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
        const reason =
          typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        if (!targetUserId) return res.status(400).json({ error: "missing userId" });
        if (reason.length < 5) {
          return res.status(400).json({ error: "reason too short (>= 5 chars)" });
        }

        const guildId = req.admin.guildId;

        let unmatchedDoc;
        try {
          unmatchedDoc = await unmatched.findOne({ _id: new ObjectId(req.params.id) });
        } catch {
          return res.status(400).json({ error: "invalid id" });
        }
        if (!unmatchedDoc) return res.status(404).json({ error: "not found" });
        if (unmatchedDoc.resolved) {
          return res.status(409).json({ error: "already resolved" });
        }

        const tradeNo = unmatchedDoc.tradeNo;
        const amountNtd = Math.floor(Number(unmatchedDoc.amountNtd) || 0);
        const platform = unmatchedDoc.platform;
        const tier = tierForAmount(amountNtd);
        const perks = computePerksSummary(tier, amountNtd);
        const grantedAt = new Date();

        const existing = await records.findOne({ tradeNo }).catch(() => null);
        if (existing) {
          await unmatched.updateOne(
            { _id: unmatchedDoc._id },
            {
              $set: {
                resolved: true,
                resolvedAt: grantedAt,
                resolvedBy: req.admin.userId,
                resolveReason: reason,
                resolveUserId: targetUserId,
                note: "record already existed",
              },
            },
          );
          return res.json({
            ok: true,
            alreadyGranted: true,
            perks: existing.perks || null,
          });
        }

        try {
          await records.insertOne({
            tradeNo,
            sessionId: null,
            userId: targetUserId,
            guildId,
            amountNtd,
            tierId: tier?.id || null,
            platform,
            patronName: unmatchedDoc.patronName || "",
            patronNote: unmatchedDoc.patronNote || "",
            perks,
            grantedAt,
            resolvedFromUnmatched: true,
            resolvedBy: req.admin.userId,
            coinsGranted: false,
            roleGranted: false,
            itemsGranted: false,
            buffGranted: false,
            themeGranted: false,
            titleGranted: false,
            announced: false,
            dmSent: false,
          });
        } catch (err) {
          if (err && err.code === 11000) {
            return res.status(409).json({ error: "trade already recorded" });
          }
          throw err;
        }

        const record = {
          tradeNo,
          sessionId: null,
          userId: targetUserId,
          guildId,
          amountNtd,
          platform,
          patronName: unmatchedDoc.patronName || "",
          patronNote: unmatchedDoc.patronNote || "",
        };

        let updates = {};
        try {
          updates = await grantDonationPerks(client, { record, tier });
        } catch (err) {
          logger.error(
            { source: "admin-donation-resolve", tradeNo, err: err.message },
            "grantDonationPerks threw",
          );
        }

        if (Object.keys(updates).length > 0) {
          await records
            .updateOne(
              { tradeNo },
              { $set: { ...updates, updatedAt: new Date() } },
            )
            .catch(() => null);
        }

        await unmatched.updateOne(
          { _id: unmatchedDoc._id },
          {
            $set: {
              resolved: true,
              resolvedAt: grantedAt,
              resolvedBy: req.admin.userId,
              resolveReason: reason,
              resolveUserId: targetUserId,
            },
          },
        );

        logger.info(
          {
            source: "admin-donation-resolve",
            tradeNo,
            adminId: req.admin.userId,
            targetUserId,
            amountNtd,
            grants: updates,
          },
          "unmatched resolved",
        );

        res.json({ ok: true, alreadyGranted: false, perks, grants: updates });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/v1/admin/donation/patrons
  router.get("/patrons", async (req, res, next) => {
    try {
      const records = client.donationRecordsCollection;
      if (!records) return res.status(503).json({ error: "db not ready" });

      const { page, pageSize } = parsePagination(req);
      const sortField =
        req.query.sort === "recent" ? "lastDonation" : "lifetimeAmount";

      const pipeline = [
        {
          $group: {
            _id: "$userId",
            lifetimeAmount: { $sum: "$amountNtd" },
            donationCount: { $sum: 1 },
            lastDonation: { $max: "$grantedAt" },
            firstDonation: { $min: "$grantedAt" },
            lastTierId: { $last: "$tierId" },
            lastPatronName: { $last: "$patronName" },
          },
        },
        { $sort: { [sortField]: -1 } },
        {
          $facet: {
            rows: [{ $skip: page * pageSize }, { $limit: pageSize }],
            meta: [{ $count: "total" }],
          },
        },
      ];

      const [agg] = await records.aggregate(pipeline).toArray();
      const rows = (agg?.rows || []).map((r) => ({
        userId: r._id,
        lifetimeAmount: r.lifetimeAmount,
        donationCount: r.donationCount,
        lastDonation: r.lastDonation,
        firstDonation: r.firstDonation,
        lastTierId: r.lastTierId,
        lastPatronName: r.lastPatronName,
      }));
      const total = agg?.meta?.[0]?.total || 0;

      res.json({ ok: true, page, pageSize, total, rows });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/donation/stats?range=30d|90d|365d|all
  router.get("/stats", async (req, res, next) => {
    try {
      const records = client.donationRecordsCollection;
      const unmatched = client.unmatchedDonationsCollection;
      if (!records || !unmatched) {
        return res.status(503).json({ error: "db not ready" });
      }

      const range = req.query.range || "30d";
      const days =
        range === "365d" ? 365 : range === "90d" ? 90 : range === "all" ? null : 30;
      const since = days
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        : null;
      const filter = since ? { grantedAt: { $gte: since } } : {};

      const [totals, byPlatform, byTier, pendingUnmatched] = await Promise.all([
        records
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: null,
                totalAmount: { $sum: "$amountNtd" },
                count: { $sum: 1 },
                uniqueUsers: { $addToSet: "$userId" },
              },
            },
          ])
          .toArray(),
        records
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: "$platform",
                amount: { $sum: "$amountNtd" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        records
          .aggregate([
            { $match: filter },
            {
              $group: {
                _id: "$tierId",
                amount: { $sum: "$amountNtd" },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray(),
        unmatched.countDocuments({ resolved: false }),
      ]);

      const t = totals[0] || { totalAmount: 0, count: 0, uniqueUsers: [] };
      res.json({
        ok: true,
        range,
        since,
        totalAmount: t.totalAmount,
        count: t.count,
        uniquePatrons: (t.uniqueUsers || []).length,
        avgAmount: t.count > 0 ? Math.round(t.totalAmount / t.count) : 0,
        byPlatform: byPlatform.map((p) => ({
          platform: p._id,
          amount: p.amount,
          count: p.count,
        })),
        byTier: byTier.map((p) => ({
          tierId: p._id,
          amount: p.amount,
          count: p.count,
        })),
        pendingUnmatched,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
