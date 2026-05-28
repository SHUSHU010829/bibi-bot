const crypto = require("node:crypto");
const logger = require("../utils/logger");
const { trackError, trackSuccess } = require("../utils/errorTracker");
const { generateCode } = require("../features/donation/code");
const { donation } = require("../config");

const MAX_CODE_RETRIES = 5;

/**
 * POST /api/donation/session — website 建立付款 session 時呼叫
 *
 * Body: { userId, guildId, amountNtd, platform }
 * Auth: Bearer ${DONATION_GRANT_SECRET}
 * Resp: { ok, sessionId, code }
 */
module.exports = function createDonationSessionHandler(client) {
  return async function handleDonationSession(req, res) {
    if (!donation?.enabled) {
      return res.status(503).json({ error: "donation disabled" });
    }

    const expectedSecret = process.env.DONATION_GRANT_SECRET;
    if (!expectedSecret) {
      logger.error({ source: "donation-session" }, "DONATION_GRANT_SECRET not configured");
      trackError("donation-session", new Error("secret not configured"));
      return res.status(503).json({ error: "secret not configured" });
    }

    const auth = req.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided || provided !== expectedSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid payload" });
    }
    const userId = typeof body.userId === "string" ? body.userId : "";
    const guildId = typeof body.guildId === "string" ? body.guildId : "";
    const amountNtd = Number(body.amountNtd);
    const platform = String(body.platform || "");

    if (!userId) return res.status(400).json({ error: "missing userId" });
    if (!guildId) return res.status(400).json({ error: "missing guildId" });
    if (!Number.isFinite(amountNtd) || amountNtd < 1) {
      return res.status(400).json({ error: "invalid amountNtd" });
    }
    if (platform !== "ecpay" && platform !== "opay") {
      return res.status(400).json({ error: "invalid platform" });
    }

    const sessions = client.donationSessionsCollection;
    if (!sessions) {
      return res.status(503).json({ error: "db not ready" });
    }

    const sessionId = crypto.randomUUID();
    const ttlMin = donation.sessionTtlMinutes ?? 30;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);

    // 撞 code 重試最多 5 次（30 億組合，30 分內幾乎不會撞，但保險）
    let code = null;
    let lastErr = null;
    for (let i = 0; i < MAX_CODE_RETRIES; i++) {
      const candidate = generateCode();
      try {
        await sessions.insertOne({
          sessionId,
          code: candidate,
          userId,
          guildId,
          amountNtd: Math.floor(amountNtd),
          platform,
          status: "pending",
          createdAt: now,
          expiresAt,
        });
        code = candidate;
        break;
      } catch (err) {
        // 11000 = duplicate key (code 撞)
        if (err && err.code === 11000) {
          lastErr = err;
          continue;
        }
        logger.error(
          { source: "donation-session", err: err.message, userId },
          "insert session failed",
        );
        trackError("donation-session", err, { phase: "insert", userId });
        return res.status(500).json({ error: "db insert failed" });
      }
    }

    if (!code) {
      logger.error(
        { source: "donation-session", retries: MAX_CODE_RETRIES },
        "code collision exhausted",
      );
      trackError("donation-session", lastErr || new Error("code collision"));
      return res.status(503).json({ error: "code collision" });
    }

    logger.info(
      { source: "donation-session", sessionId, code, userId, amountNtd, platform },
      "session created",
    );
    trackSuccess("donation-session");

    return res.status(200).json({ ok: true, sessionId, code });
  };
};
