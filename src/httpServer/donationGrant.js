const logger = require("../utils/logger");
const { trackError, trackSuccess } = require("../utils/errorTracker");
const { tierForAmount } = require("../features/donation/code");
const grantDonationPerks = require("../features/donation/grantDonationPerks");
const { computePerksSummary } = require("../features/donation/perksSummary");
const { donation } = require("../config");

/**
 * POST /api/donation/grant — website webhook 收到付款後呼叫
 *
 * Body: { code, tradeNo, amountNtd, platform, patronName, patronNote }
 * Auth: Bearer ${DONATION_GRANT_SECRET}
 * Resp: { ok, matched, alreadyGranted, perks? }
 *
 * 行為：
 * 1. tradeNo unique 做冪等（重送安全）
 * 2. 用 code 找 pending session：找到 → 發放 + 寫 records + 翻 session=completed
 *                              找不到 → 寫 unmatched_donations 給人工補發
 * 3. 真實 perks 發放（金幣 / 身分組 / 道具 / 限定外觀）→ 下一個 step，目前先
 *    記錄並 log，回傳 perks 摘要供 website success 頁顯示
 */
module.exports = function createDonationGrantHandler(client) {
  return async function handleDonationGrant(req, res) {
    if (!donation?.enabled) {
      return res.status(503).json({ error: "donation disabled" });
    }

    const expectedSecret = process.env.DONATION_GRANT_SECRET;
    if (!expectedSecret) {
      logger.error({ source: "donation-grant" }, "DONATION_GRANT_SECRET not configured");
      trackError("donation-grant", new Error("secret not configured"));
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
    const code = typeof body.code === "string" ? body.code : null;
    const tradeNo = typeof body.tradeNo === "string" ? body.tradeNo : "";
    const amountNtd = Number(body.amountNtd);
    const platform = String(body.platform || "");
    const patronName = String(body.patronName || "");
    const patronNote = String(body.patronNote || "");

    if (!tradeNo) return res.status(400).json({ error: "missing tradeNo" });
    if (!Number.isFinite(amountNtd) || amountNtd <= 0) {
      return res.status(400).json({ error: "invalid amountNtd" });
    }
    if (platform !== "ecpay" && platform !== "opay") {
      return res.status(400).json({ error: "invalid platform" });
    }

    const sessions = client.donationSessionsCollection;
    const records = client.donationRecordsCollection;
    const unmatched = client.unmatchedDonationsCollection;
    if (!sessions || !records || !unmatched) {
      return res.status(503).json({ error: "db not ready" });
    }

    // 1. 冪等檢查
    const existing = await records.findOne({ tradeNo }).catch(() => null);
    if (existing) {
      logger.info(
        { source: "donation-grant", tradeNo, code },
        "already granted (idempotent)",
      );
      return res.status(200).json({
        ok: true,
        matched: true,
        alreadyGranted: true,
        perks: existing.perks || null,
      });
    }

    // 2. 找 session
    const session = code
      ? await sessions.findOne({ code, status: "pending" }).catch(() => null)
      : null;

    // 防禦性 trim：舊版 session 可能存了夾帶空白的 guildId/userId（PRIMARY_GUILD_ID
    // env 污染），會讓以 {userId, guildId} 為鍵的 Mongo 發放落到孤兒桶。在此校正，
    // 確保 record 與後續 grantDonationPerks 都用乾淨的 ID。
    if (session) {
      if (typeof session.guildId === "string") session.guildId = session.guildId.trim();
      if (typeof session.userId === "string") session.userId = session.userId.trim();
    }

    if (!session) {
      // code 對不到 → 寫 unmatched 供人工補發
      try {
        await unmatched.insertOne({
          tradeNo,
          platform,
          amountNtd: Math.floor(amountNtd),
          patronName,
          patronNote,
          codeAttempt: code,
          resolved: false,
          createdAt: new Date(),
        });
      } catch (err) {
        // 11000 = duplicate trade_no（webhook 重送時可能撞），忽略
        if (!(err && err.code === 11000)) {
          logger.error(
            { source: "donation-grant", tradeNo, err: err.message },
            "unmatched insert failed",
          );
          trackError("donation-grant", err, { phase: "unmatched", tradeNo });
        }
      }

      logger.warn(
        { source: "donation-grant", tradeNo, code, amountNtd, patronName, patronNote },
        "code not matched → unmatched",
      );
      // ok:true matched:false：webhook 不需重送（會永遠對不到），等人工處理
      return res.status(200).json({ ok: true, matched: false });
    }

    // 3. 找到 session：依「實際付款金額」判方案（donor 在付款頁可能改金額）
    const tier = tierForAmount(amountNtd);
    if (!tier) {
      // 金額 < 50 元 → 不發放方案回饋，但仍寫 record + 翻 session 表示已處理
      logger.warn(
        { source: "donation-grant", tradeNo, amountNtd, userId: session.userId },
        "amount below tier threshold → no perks",
      );
    }

    const perks = tier ? computePerksSummary(tier, amountNtd) : null;
    const grantedAt = new Date();

    // 寫 donation_records（tradeNo unique 防併發重複）
    try {
      await records.insertOne({
        tradeNo,
        sessionId: session.sessionId,
        userId: session.userId,
        guildId: session.guildId,
        amountNtd: Math.floor(amountNtd),
        tierId: tier?.id || null,
        platform,
        patronName,
        patronNote,
        perks,
        grantedAt,
        // step 4 真實發放完成後寫這幾個欄位，現在先放 false
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
        // race：另一個 webhook 已經寫了 → 走冪等回應
        const racedRecord = await records.findOne({ tradeNo }).catch(() => null);
        return res.status(200).json({
          ok: true,
          matched: true,
          alreadyGranted: true,
          perks: racedRecord?.perks || null,
        });
      }
      logger.error(
        { source: "donation-grant", tradeNo, err: err.message },
        "record insert failed",
      );
      trackError("donation-grant", err, { phase: "record-insert", tradeNo });
      return res.status(500).json({ error: "record insert failed" });
    }

    // 翻 session 為 completed
    try {
      await sessions.updateOne(
        { sessionId: session.sessionId },
        { $set: { status: "completed", completedAt: grantedAt, tradeNo } },
      );
    } catch (err) {
      logger.error(
        { source: "donation-grant", sessionId: session.sessionId, err: err.message },
        "session update failed",
      );
      // 不影響本次發放結果，繼續
    }

    // 真實發放 perks（每項獨立 try/catch、失敗 log 不阻塞其他項目）
    const record = {
      tradeNo,
      sessionId: session.sessionId,
      userId: session.userId,
      guildId: session.guildId,
      amountNtd: Math.floor(amountNtd),
      platform,
      patronName,
      patronNote,
    };

    let updates = {};
    try {
      updates = await grantDonationPerks(client, { record, tier });
    } catch (err) {
      logger.error(
        { source: "donation-grant", tradeNo, err: err.message, stack: err.stack },
        "grantDonationPerks threw (outer)",
      );
      trackError("donation-grant", err, { phase: "grant-perks-outer", tradeNo });
    }

    // 把哪些項目發放成功寫回 record
    if (Object.keys(updates).length > 0) {
      try {
        await records.updateOne(
          { tradeNo },
          { $set: { ...updates, updatedAt: new Date() } },
        );
      } catch (err) {
        logger.warn(
          { source: "donation-grant", tradeNo, err: err.message },
          "record flag update failed (non-fatal)",
        );
      }
    }

    logger.info(
      {
        source: "donation-grant",
        tradeNo,
        sessionId: session.sessionId,
        userId: session.userId,
        amountNtd,
        tier: tier?.id || null,
        grants: updates,
      },
      "donation granted",
    );
    trackSuccess("donation-grant");

    return res.status(200).json({
      ok: true,
      matched: true,
      alreadyGranted: false,
      perks,
      grants: updates,
    });
  };
};

