const express = require("express");
const { BSON } = require("mongodb");

// Dashboard（bibi-website，部署在 Vercel）唯讀資料查詢端點。
//
// 網站連不到 bot 所在 Vultr 的內網 Mongo，故所有 dashboard / 個人資料頁的讀取都
// 轉發到這裡，由 bot 對本機 Mongo 執行「唯讀」查詢後以 EJSON 回傳（EJSON 保留
// Date / 數字型別，網站端還原後彙總邏輯完全不用改）。
//
// 安全性（這是對公網開放的端點，務必收緊）：
//   1. 需帶 x-dashboard-secret，比對 DASHBOARD_READONLY_SECRET；未設 → 直接停用。
//   2. collection 白名單：只允許 dashboard 實際會讀的表。
//   3. 運算子 default-deny：filter / pipeline 內任何 $ 開頭的 key 必須在白名單，
//      擋掉 $where / $function / $out / $merge / $lookup 等危險 / 寫入類運算子。
//   4. 只支援 find / findOne / countDocuments / aggregate / distinct，無任何寫入。

const ALLOWED_COLLECTIONS = new Set([
  "UserCoins",
  "UserLevels",
  "MiningProfiles",
  "WorkProfiles",
  "UserInventory",
  "QuestProgress",
  "QuestAssignments",
  "CoinTransactions",
  "InviteRecords",
  "DuelGames",
  "LotteryDraws",
  "LotteryTickets",
  "GuildClubMembers",
  "GuildsClub",
  "FarmPlots",
  "UserPortfolio",
  "StockMarket",
  "DonationRecords",
]);

// 唯讀查詢 / 聚合運算子白名單（其餘 $ 開頭 key 一律拒絕）。
const ALLOWED_OPERATORS = new Set([
  // 查詢
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$and", "$or", "$nor", "$not", "$exists", "$type", "$regex", "$options",
  "$elemMatch", "$size", "$all", "$mod",
  // 聚合階段
  "$match", "$group", "$sort", "$limit", "$skip", "$count", "$project", "$unwind",
  // 聚合運算式（唯讀）
  "$sum", "$avg", "$min", "$max", "$first", "$last",
  "$cond", "$ifNull", "$multiply", "$divide", "$add", "$subtract",
  "$toInt", "$toDouble", "$toString", "$dateToString",
]);

const MAX_LIMIT = 2000;
const MAX_PIPELINE_STAGES = 16;
const ALLOWED_OPS = new Set(["find", "findOne", "countDocuments", "aggregate", "distinct"]);

// 遞迴掃描：任何 $ 開頭的物件 key 不在白名單就拒絕（field 參照如 "$symbol" 是
// value 不是 key，不受影響）。
function assertSafeOperators(node) {
  if (Array.isArray(node)) {
    for (const el of node) assertSafeOperators(el);
    return;
  }
  if (node && typeof node === "object" && !(node instanceof Date)) {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$") && !ALLOWED_OPERATORS.has(k)) {
        throw new Error(`forbidden operator: ${k}`);
      }
      assertSafeOperators(v);
    }
  }
}

module.exports = function createDashboardQueryRouter(client) {
  const router = express.Router();

  // 收原始 EJSON 字串（避免被全域 express.json 依 application/json 攔走）。
  router.use(express.text({ type: "application/ejson", limit: "1mb" }));

  router.post("/query", async (req, res, next) => {
    try {
      const secret = process.env.DASHBOARD_READONLY_SECRET;
      if (!secret) {
        return res.status(503).json({ error: "dashboard query disabled" });
      }
      if (req.header("x-dashboard-secret") !== secret) {
        return res.status(401).json({ error: "unauthorized" });
      }

      let body;
      try {
        body = BSON.EJSON.parse(typeof req.body === "string" ? req.body : "{}");
      } catch {
        return res.status(400).json({ error: "invalid ejson body" });
      }

      const { collection, op } = body;
      if (!ALLOWED_COLLECTIONS.has(collection)) {
        return res.status(400).json({ error: "collection not allowed" });
      }
      if (!ALLOWED_OPS.has(op)) {
        return res.status(400).json({ error: "op not allowed" });
      }

      const col = client.database.collection(collection);
      const filter = body.filter || {};
      assertSafeOperators(filter);

      let result;
      if (op === "find") {
        const opts = {};
        if (body.projection) opts.projection = body.projection;
        let cursor = col.find(filter, opts);
        if (body.sort) cursor = cursor.sort(body.sort);
        if (body.skip) cursor = cursor.skip(Math.max(0, Number(body.skip) || 0));
        cursor = cursor.limit(Math.min(MAX_LIMIT, Number(body.limit) || MAX_LIMIT));
        result = await cursor.toArray();
      } else if (op === "findOne") {
        const opts = {};
        if (body.projection) opts.projection = body.projection;
        result = await col.findOne(filter, opts);
      } else if (op === "countDocuments") {
        result = await col.countDocuments(filter);
      } else if (op === "distinct") {
        result = await col.distinct(String(body.field || ""), filter);
      } else {
        // aggregate
        const pipeline = Array.isArray(body.pipeline) ? body.pipeline : [];
        if (pipeline.length > MAX_PIPELINE_STAGES) {
          return res.status(400).json({ error: "pipeline too long" });
        }
        assertSafeOperators(pipeline);
        result = await col.aggregate(pipeline).toArray();
      }

      res
        .type("application/json")
        .send(BSON.EJSON.stringify({ ok: true, result }, { relaxed: true }));
    } catch (err) {
      next(err);
    }
  });

  return router;
};
