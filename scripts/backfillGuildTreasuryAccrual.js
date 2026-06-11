require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

/**
 * 回補「公會寄賣售出 / 倉庫取貨手續費」漏算的金庫累積額（treasury）。
 *
 * 背景：這兩條入帳路徑原本只 $inc treasury_current（可分配餘額），
 *      漏掉 treasury（金庫累積，公會頁面顯示用＋升級門檻用）。
 *      所以售出/取貨紀錄都在、餘額也對，但「金庫」數字沒跟著漲。
 *      程式面已修（同時累加兩欄位），這支腳本把修正前的歷史補回 treasury。
 *
 * 補的金額來源（GuildClubWarehouseLogs）：
 *   - action="consign_sold" → price（售出金額，當初已進 treasury_current）
 *   - action="withdraw"     → fee  （取貨手續費，當初已進 treasury_current）
 *   只補 treasury（累積），不動 treasury_current（餘額本來就對）。
 *
 * 限制：該 logs collection 有 90 天 TTL，超過 90 天的紀錄已被清掉、無法回補。
 *
 * 重要：cutoff 預設為「執行當下」。修正部署後新產生的售出/取貨會自己正確累加
 *      treasury，若用預設 cutoff 在部署後執行會把那些新紀錄重複計入。
 *   → 建議「部署修正前」執行；若已部署，請用 --before 指定部署時間點，
 *     例如 node scripts/backfillGuildTreasuryAccrual.js apply --before "2026-06-11T00:00:00Z"
 *   已處理的紀錄會被打上 treasury_backfilled_at 標記，重複執行不會重算。
 *
 * 執行方式：
 *   node scripts/backfillGuildTreasuryAccrual.js                 # dry-run
 *   node scripts/backfillGuildTreasuryAccrual.js apply           # 實際執行
 *   node scripts/backfillGuildTreasuryAccrual.js apply --before "2026-06-11T00:00:00Z"
 */

const ACTIONS = ["consign_sold", "withdraw"];

function parseCutoff() {
  const i = process.argv.indexOf("--before");
  if (i === -1 || !process.argv[i + 1]) return new Date();
  const d = new Date(process.argv[i + 1]);
  if (isNaN(d.getTime())) {
    console.log(`[ERROR] --before 時間格式無法解析：${process.argv[i + 1]}`.red);
    process.exit(1);
  }
  return d;
}

async function main() {
  const shouldApply = process.argv.includes("apply");
  const cutoff = parseCutoff();

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);
    console.log(`[INFO] cutoff（只處理此時間之前的紀錄）：${cutoff.toISOString()}`.cyan);

    const database = mongoClient.db("MorningBot");
    const guildsClubCollection = database.collection("GuildsClub");
    const logsCollection = database.collection("GuildClubWarehouseLogs");

    // 依公會彙總尚未回補、cutoff 之前、金額 > 0 的 consign_sold / withdraw 紀錄
    const grouped = await logsCollection
      .aggregate([
        {
          $match: {
            action: { $in: ACTIONS },
            created_at: { $lt: cutoff },
            treasury_backfilled_at: { $exists: false },
          },
        },
        {
          $project: {
            guild_club_id: 1,
            action: 1,
            amount: {
              $cond: [
                { $eq: ["$action", "consign_sold"] },
                { $ifNull: ["$price", 0] },
                { $ifNull: ["$fee", 0] },
              ],
            },
          },
        },
        { $match: { amount: { $gt: 0 } } },
        {
          $group: {
            _id: "$guild_club_id",
            total: { $sum: "$amount" },
            consignTotal: {
              $sum: { $cond: [{ $eq: ["$action", "consign_sold"] }, "$amount", 0] },
            },
            withdrawTotal: {
              $sum: { $cond: [{ $eq: ["$action", "withdraw"] }, "$amount", 0] },
            },
            count: { $sum: 1 },
            ids: { $push: "$_id" },
          },
        },
        { $sort: { total: -1 } },
      ])
      .toArray();

    if (grouped.length === 0) {
      console.log("[INFO] 沒有任何待回補的紀錄（可能都超過 90 天 TTL 或已回補）".yellow);
      return;
    }

    // 只補存在且未解散的公會
    const clubIds = grouped.map((g) => g._id);
    const clubs = await guildsClubCollection
      .find({ guild_club_id: { $in: clubIds } })
      .project({ guild_club_id: 1, name: 1, treasury: 1, treasury_current: 1, disbanded_at: 1 })
      .toArray();
    const clubMap = new Map(clubs.map((c) => [c.guild_club_id, c]));

    const valid = [];
    const skipped = [];
    for (const g of grouped) {
      const club = clubMap.get(g._id);
      if (!club) {
        skipped.push({ ...g, reason: "club_missing" });
      } else if (club.disbanded_at) {
        skipped.push({ ...g, reason: "disbanded", name: club.name });
      } else {
        valid.push({ ...g, name: club.name, club });
      }
    }

    console.log(`\n[預覽] 待回補公會：${valid.length} 個，跳過：${skipped.length} 個`.cyan);
    let grandTotal = 0;
    let grandLogs = 0;
    for (const g of valid) {
      grandTotal += g.total;
      grandLogs += g.count;
      const cur = g.club.treasury || 0;
      console.log(
        `  ${g.name || g._id}：treasury +${g.total.toLocaleString()} `.white +
          `（售出 ${g.consignTotal.toLocaleString()}・取貨費 ${g.withdrawTotal.toLocaleString()}，${g.count} 筆）` +
          ` ${cur.toLocaleString()} → ${(cur + g.total).toLocaleString()}`.gray
      );
    }
    console.log(
      `\n  合計：treasury +${grandTotal.toLocaleString()} 幣，涵蓋 ${grandLogs} 筆紀錄`.green
    );
    if (skipped.length > 0) {
      console.log(`\n  [跳過] 以下公會不回補：`.yellow);
      for (const s of skipped) {
        console.log(
          `    ${s.name || s._id}（${s.reason}）：原可補 ${s.total.toLocaleString()}`.gray
        );
      }
    }

    if (!shouldApply) {
      console.log(
        "\n[INFO] 這是 dry-run。確認無誤後執行 `node scripts/backfillGuildTreasuryAccrual.js apply`".yellow
      );
      console.log(
        "[INFO] 若修正已部署，務必加 --before \"<部署時間 ISO>\" 以排除部署後正確入帳的新紀錄".yellow
      );
      return;
    }

    console.log("\n[WARNING] 5 秒後開始回補，按 Ctrl+C 取消...".yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const appliedAt = new Date();
    const stats = { ok: 0, inc_failed: 0, total: 0 };

    for (const g of valid) {
      // 先標記這批紀錄（避免重複執行重算），再累加 treasury。
      // 若 inc 失敗，標記已存在 → 重跑不會重算，腳本會印出需手動補的公會與金額。
      await logsCollection.updateMany(
        { _id: { $in: g.ids } },
        { $set: { treasury_backfilled_at: appliedAt } }
      );

      const upd = await guildsClubCollection.updateOne(
        { guild_club_id: g._id, disbanded_at: null },
        { $inc: { treasury: g.total }, $set: { updated_at: appliedAt } }
      );

      if (upd.matchedCount === 1) {
        stats.ok++;
        stats.total += g.total;
        console.log(`  [OK] ${g.name || g._id}：+${g.total.toLocaleString()}`.green);
      } else {
        stats.inc_failed++;
        console.log(
          `  [FAIL] ${g.name || g._id}：紀錄已標記但 treasury 未累加（公會剛解散？）`.red +
            ` → 需手動 $inc treasury ${g.total.toLocaleString()}`.red
        );
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 回補完成`.green);
    console.log(`  成功公會：${stats.ok} 個，累加 treasury 合計 ${stats.total.toLocaleString()} 幣`.white);
    if (stats.inc_failed > 0) {
      console.log(`  累加失敗（需手動處理）：${stats.inc_failed} 個`.red);
    }
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`[ERROR] 執行失敗：\n${error}\n${error.stack}`.red);
    process.exit(1);
  } finally {
    await mongoClient.close();
    console.log("\n[INFO] MongoDB 連線已關閉".cyan);
  }
}

main();
