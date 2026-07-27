const express = require("express");
const createFlushChatScoreHandler = require("./flushChatScore");
const createDonationSessionHandler = require("./donationSession");
const createDonationGrantHandler = require("./donationGrant");
const createLeaderboardRouter = require("./leaderboardApi");
const createStocksRouter = require("./stocksApi");
const createGuildClubsRouter = require("./guildClubsApi");
const createAdminMeHandler = require("./adminMe");
const createAdminDonationRouter = require("./adminDonationApi");
const createAdminUsersRouter = require("./adminUsersApi");
const createAdminCronRouter = require("./adminCronApi");
const createAdminEconomyRouter = require("./adminEconomyApi");
const createPublicProfileHandler = require("./publicProfileApi");
const requireAdmin = require("./middleware/requireAdmin");
const logger = require("../utils/logger");
const { snapshot } = require("../utils/errorTracker");
const eventLoopMonitor = require("../utils/eventLoopMonitor");

module.exports = function startHttpServer(client) {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, ready: client.isReady() });
  });

  // 診斷端點：列出最近 N 分鐘各服務 (source) 的成功/失敗次數,
  // 用來找出是哪一塊服務在連續失敗。設 DISCORD_BOT_DIAGNOSTICS_TOKEN
  // 後需附 `x-diagnostics-token` header 才會回應。
  app.get("/diagnostics", (req, res) => {
    const token = process.env.DISCORD_BOT_DIAGNOSTICS_TOKEN;
    if (token) {
      const got = req.header("x-diagnostics-token");
      if (got !== token) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }
    const snap = snapshot();
    const sortedSources = Object.entries(snap.sources)
      .sort(
        ([, a], [, b]) =>
          b.errorsLastWindow - a.errorsLastWindow ||
          b.errorsTotal - a.errorsTotal
      )
      .reduce((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {});
    res.status(200).json({
      ok: true,
      ready: client.isReady(),
      windowMs: snap.windowMs,
      sources: sortedSources,
      eventLoopDelayMs: eventLoopMonitor.snapshot(),
    });
  });

  app.post("/api/twitch-chat-score", createFlushChatScoreHandler(client));

  // 抖內系統（bibi-website 呼叫）
  app.post("/api/donation/session", createDonationSessionHandler(client));
  app.post("/api/donation/grant", createDonationGrantHandler(client));

  // 排行榜 API（Dashboard 讀取）
  app.use("/api/v1/leaderboard", createLeaderboardRouter(client));

  // 股市 API（Dashboard 股市頁讀取；網站在 Vercel 連不到內網 Mongo，一律走這裡）
  app.use("/api/v1/stocks", createStocksRouter(client));

  // 公會排行 API（公開，Phase A）
  app.use("/api/v1/guild_clubs", createGuildClubsRouter(client));

  // 公開玩家卡片 API（無 auth，但會檢查 UserSettings.publicProfile）
  app.get("/api/v1/u/:userId", createPublicProfileHandler(client));

  // Admin API（Dashboard 後台，需 DASHBOARD_ADMIN_SECRET + 使用者具 ManageGuild）
  app.get("/api/v1/admin/me", requireAdmin(client), createAdminMeHandler());
  app.use("/api/v1/admin/donation", createAdminDonationRouter(client));
  app.use("/api/v1/admin/users", createAdminUsersRouter(client));
  app.use("/api/v1/admin/cron", createAdminCronRouter(client));
  app.use("/api/v1/admin/economy", createAdminEconomyRouter(client));

  app.use((err, _req, res, _next) => {
    logger.error({ source: "http", err: err.message, stack: err.stack }, "HTTP unhandled error");
    res.status(500).json({ error: "internal" });
  });

  const port = Number(process.env.PORT) || 8080;
  const server = app.listen(port, () => {
    logger.info({ source: "http", port }, "HTTP server listening");
  });

  server.on("error", (err) => {
    logger.error({ source: "http", err: err.message }, "HTTP server error");
  });

  return server;
};
