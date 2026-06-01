const logger = require("../../utils/logger");

/**
 * 包裝 admin handler，成功時自動寫一筆 DashboardAuditLog。
 *
 * 用法：
 *   router.post('/users/:id/coins',
 *     requireAdmin(client),
 *     withAudit(client, 'economy.adjust', (req) => ({
 *       targetId: req.params.id,
 *       payload: { delta: req.body.delta },
 *       reason: req.body.reason,
 *     })),
 *     async (req, res) => { ... });
 *
 * handler 失敗（throw 或 res.status >= 400）時不寫 audit，避免噪音。
 */
module.exports = function withAudit(client, action, extract) {
  return async function (req, res, next) {
    const originalJson = res.json.bind(res);
    let captured = null;

    res.json = function (body) {
      captured = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const col = client.dashboardAuditLogCollection;
      if (!col) return;

      let extracted = {};
      try {
        extracted = extract ? extract(req, captured) || {} : {};
      } catch (err) {
        logger.warn(
          { source: "admin-audit", err: err.message, action },
          "audit extract failed",
        );
      }

      const doc = {
        action,
        adminId: req.admin?.userId ?? null,
        targetId: extracted.targetId ?? null,
        payload: extracted.payload ?? null,
        reason: extracted.reason ?? null,
        ip:
          req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
          req.socket?.remoteAddress ||
          null,
        ts: new Date(),
      };

      col.insertOne(doc).catch((err) => {
        logger.error(
          { source: "admin-audit", err: err.message, action },
          "audit insert failed",
        );
      });
    });

    next();
  };
};
