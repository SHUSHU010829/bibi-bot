const { PermissionFlagsBits } = require("discord.js");
const logger = require("../../utils/logger");

/**
 * Admin middleware for dashboard-driven endpoints.
 *
 * 認證模式：website 是受信任的呼叫端（與 donation API 同模式）。
 *   - `Authorization: Bearer <DASHBOARD_ADMIN_SECRET>` 驗 server-to-server 身分
 *   - Header `X-Admin-User-Id` / body.userId / query.userId 帶 Discord 使用者 ID
 *   - Header `X-Admin-Guild-Id` / body.guildId / query.guildId 帶要檢查權限的 guild
 *     （由 website 端的 PRIMARY_GUILD_ID 提供；本 bot 也接受退回 GUILD_ID env）
 *   - 本 middleware 查 guild member，檢查 ManageGuild
 *
 * 通過後在 req.admin 掛：{ userId, guildId, isOwner, member }
 */
module.exports = function requireAdmin(client) {
  return async function (req, res, next) {
    const expectedSecret = process.env.DASHBOARD_ADMIN_SECRET;
    if (!expectedSecret) {
      return res.status(503).json({ error: "admin secret not configured" });
    }

    const auth = req.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!provided || provided !== expectedSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const userId =
      (typeof req.body?.userId === "string" && req.body.userId.trim()) ||
      (typeof req.query?.userId === "string" && req.query.userId.trim()) ||
      (typeof req.headers["x-admin-user-id"] === "string" &&
        req.headers["x-admin-user-id"].trim()) ||
      "";

    if (!userId) {
      return res.status(400).json({ error: "missing userId" });
    }

    const guildId =
      (typeof req.headers["x-admin-guild-id"] === "string" &&
        req.headers["x-admin-guild-id"].trim()) ||
      (typeof req.body?.guildId === "string" && req.body.guildId.trim()) ||
      (typeof req.query?.guildId === "string" && req.query.guildId.trim()) ||
      process.env.GUILD_ID ||
      process.env.PRIMARY_GUILD_ID ||
      "";

    if (!guildId) {
      return res.status(503).json({ error: "guildId not provided" });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(503).json({ error: "guild not in cache" });
    }

    let member;
    try {
      member = await guild.members.fetch(userId);
    } catch {
      return res.status(403).json({ error: "not a member" });
    }

    const perms = member.permissions;
    const isAdmin =
      perms.has(PermissionFlagsBits.ManageGuild) ||
      perms.has(PermissionFlagsBits.Administrator);
    const isOwner = process.env.OWNER_ID === userId;

    if (!isAdmin && !isOwner) {
      logger.warn(
        { source: "admin-auth", userId, path: req.path },
        "admin permission denied",
      );
      return res.status(403).json({ error: "forbidden" });
    }

    req.admin = { userId, guildId, isOwner, member };
    next();
  };
};
