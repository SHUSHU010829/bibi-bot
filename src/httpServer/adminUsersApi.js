const express = require("express");
const logger = require("../utils/logger");
const requireAdmin = require("./middleware/requireAdmin");
const withAudit = require("./middleware/withAudit");
const grantCoins = require("../features/economy/grantCoins");
const grantXp = require("../features/leveling/grantXp");
const { coinHistory } = require("../config");

const TX_SOURCE_LABELS = coinHistory?.sourceLabels || {};

const SEARCH_LIMIT = 25;
const TX_RECENT_DEFAULT = 50;
const TX_RECENT_MAX = 200;

module.exports = function createAdminUsersRouter(client) {
  const router = express.Router();
  router.use(requireAdmin(client));

  // GET /api/v1/admin/users/search?q=
  router.get("/search", async (req, res, next) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      if (!q) return res.json({ ok: true, rows: [] });

      const guild = client.guilds.cache.get(req.admin.guildId);
      if (!guild) return res.status(503).json({ error: "guild not in cache" });

      // 直接 ID 命中 → 強制 fetch
      if (/^\d{15,20}$/.test(q)) {
        const m = await guild.members.fetch(q).catch(() => null);
        if (m) {
          return res.json({
            ok: true,
            rows: [memberRow(m)],
          });
        }
      }

      const rows = [];
      for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        const name = (m.user.globalName || m.user.username || "").toLowerCase();
        const nick = (m.nickname || "").toLowerCase();
        if (name.includes(q) || nick.includes(q) || m.user.username.toLowerCase().includes(q)) {
          rows.push(memberRow(m));
          if (rows.length >= SEARCH_LIMIT) break;
        }
      }

      res.json({ ok: true, rows });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/v1/admin/users/:userId
  router.get("/:userId", async (req, res, next) => {
    try {
      const targetId = req.params.userId;
      if (!/^\d{15,20}$/.test(targetId)) {
        return res.status(400).json({ error: "invalid userId" });
      }
      const guildId = req.admin.guildId;
      const guild = client.guilds.cache.get(guildId);

      const txLimit = Math.min(
        Math.max(Number(req.query.tx) || TX_RECENT_DEFAULT, 1),
        TX_RECENT_MAX,
      );

      const member = await guild.members.fetch(targetId).catch(() => null);
      if (!member) return res.status(404).json({ error: "not a member" });

      const [coin, level, recentTx, last30] = await Promise.all([
        client.userCoinsCollection
          .findOne({ userId: targetId, guildId })
          .catch(() => null),
        client.userLevelsCollection
          .findOne({ userId: targetId, guildId })
          .catch(() => null),
        client.coinTransactionsCollection
          .find({ userId: targetId, guildId })
          .sort({ createdAt: -1 })
          .limit(txLimit)
          .toArray()
          .catch(() => []),
        client.coinTransactionsCollection
          .aggregate([
            {
              $match: {
                userId: targetId,
                guildId,
                createdAt: {
                  $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                },
              },
            },
            {
              $group: {
                _id: null,
                inflow: {
                  $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                },
                outflow: {
                  $sum: { $cond: [{ $lt: ["$amount", 0] }, "$amount", 0] },
                },
                count: { $sum: 1 },
              },
            },
          ])
          .toArray()
          .catch(() => []),
      ]);

      const last30Net = last30[0] || { inflow: 0, outflow: 0, count: 0 };

      res.json({
        ok: true,
        user: memberRow(member),
        coin: {
          balance: coin?.totalCoins ?? 0,
          lifetime: coin?.lifetimeCoins ?? 0,
        },
        level: {
          level: level?.level ?? 0,
          totalXp: level?.totalXp ?? 0,
          streak: level?.streak ?? 0,
        },
        last30Days: {
          inflow: last30Net.inflow || 0,
          outflow: last30Net.outflow || 0,
          net: (last30Net.inflow || 0) + (last30Net.outflow || 0),
          count: last30Net.count || 0,
        },
        recentTx: recentTx.map((t) => ({
          createdAt: t.createdAt,
          source: t.source,
          sourceLabel: TX_SOURCE_LABELS[t.source] || t.source,
          amount: t.amount,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/v1/admin/users/:userId/coins
  router.post(
    "/:userId/coins",
    withAudit(client, "economy.coins.adjust", (req) => ({
      targetId: req.params.userId,
      payload: { delta: req.body?.delta },
      reason: req.body?.reason,
    })),
    async (req, res, next) => {
      try {
        const targetId = req.params.userId;
        const delta = Math.floor(Number(req.body?.delta));
        const reason =
          typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        const notify = Boolean(req.body?.notify);

        if (!/^\d{15,20}$/.test(targetId)) {
          return res.status(400).json({ error: "invalid userId" });
        }
        if (!Number.isFinite(delta) || delta === 0) {
          return res.status(400).json({ error: "delta must be non-zero integer" });
        }
        if (reason.length < 5) {
          return res.status(400).json({ error: "reason too short (>= 5 chars)" });
        }

        const guildId = req.admin.guildId;
        const guild = client.guilds.cache.get(guildId);
        const member = await guild.members.fetch(targetId).catch(() => null);
        if (!member) return res.status(404).json({ error: "not a member" });

        const result = await grantCoins(client, {
          userId: targetId,
          guildId,
          amount: delta,
          source: "admin",
          member,
          meta: { adminId: req.admin.userId, reason },
        });

        if (notify) {
          await sendAdjustDM(member, "coin", delta, reason).catch((err) => {
            logger.warn(
              { source: "admin-economy", err: err.message, targetId },
              "notify DM failed (non-fatal)",
            );
          });
        }

        logger.info(
          {
            source: "admin-economy",
            adminId: req.admin.userId,
            targetId,
            delta,
            reason,
          },
          "admin coin adjust",
        );

        res.json({
          ok: true,
          delta,
          newBalance: result?.newBalance ?? null,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/v1/admin/users/:userId/xp
  // 目前只支援正向加 XP（grantXp 限制）；要扣等級先擱置，需求很少。
  router.post(
    "/:userId/xp",
    withAudit(client, "economy.xp.add", (req) => ({
      targetId: req.params.userId,
      payload: { delta: req.body?.delta },
      reason: req.body?.reason,
    })),
    async (req, res, next) => {
      try {
        const targetId = req.params.userId;
        const delta = Math.floor(Number(req.body?.delta));
        const reason =
          typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
        const notify = Boolean(req.body?.notify);

        if (!/^\d{15,20}$/.test(targetId)) {
          return res.status(400).json({ error: "invalid userId" });
        }
        if (!Number.isFinite(delta) || delta <= 0) {
          return res.status(400).json({ error: "delta must be positive integer" });
        }
        if (reason.length < 5) {
          return res.status(400).json({ error: "reason too short (>= 5 chars)" });
        }

        const guildId = req.admin.guildId;
        const guild = client.guilds.cache.get(guildId);
        const member = await guild.members.fetch(targetId).catch(() => null);
        if (!member) return res.status(404).json({ error: "not a member" });

        await grantXp(client, {
          userId: targetId,
          guildId,
          amount: delta,
          source: "admin",
          member,
        });

        if (notify) {
          await sendAdjustDM(member, "xp", delta, reason).catch((err) => {
            logger.warn(
              { source: "admin-economy", err: err.message, targetId },
              "notify DM failed (non-fatal)",
            );
          });
        }

        logger.info(
          {
            source: "admin-economy",
            adminId: req.admin.userId,
            targetId,
            delta,
            reason,
            kind: "xp",
          },
          "admin xp grant",
        );

        res.json({ ok: true, delta });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
};

function memberRow(m) {
  return {
    userId: m.user.id,
    username: m.user.username,
    globalName: m.user.globalName,
    displayName: m.displayName,
    avatar: m.user.displayAvatarURL({ size: 64 }),
    bot: m.user.bot,
  };
}

async function sendAdjustDM(member, kind, delta, reason) {
  const sign = delta >= 0 ? "+" : "";
  const label = kind === "coin" ? "金幣" : "經驗值";
  const lines = [
    `📋 管理員調整通知`,
    ``,
    `${label}：${sign}${delta.toLocaleString()}`,
    `理由：${reason}`,
  ];
  await member.send(lines.join("\n"));
}
