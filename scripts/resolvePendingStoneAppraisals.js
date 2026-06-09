require("colors");
require("dotenv").config();

const { MongoClient } = require("mongodb");

const appraisalService = require("../src/features/mining/stoneAppraisalService");
const { mining } = require("../src/config");

/**
 * 把目前卡住的「碎石合成觸發」賭石（synthetic pending_appraisal）全部開出來。
 *
 * 背景：/合成 直接路徑原本沒帶「立刻賭石」按鈕（PR #464 修了），
 *      在那之前用 /合成 合出碎石賭石的玩家會卡一筆 pending_appraisal、
 *      過了 10 分鐘視窗就再也按不到。這支腳本把那批 pending 重設 ts、
 *      用正規服務跑完賭石流程：照常扣鑑定費、背包滿則溢出折金幣。
 *
 * 執行方式：
 *   node scripts/resolvePendingStoneAppraisals.js          # dry-run，只列出會被影響的人
 *   node scripts/resolvePendingStoneAppraisals.js apply    # 實際執行
 */

const SOURCE_FILTER = { "pending_appraisal.synthetic": true };

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 環境變數未設定".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);

  try {
    await mongoClient.connect();
    console.log("[SUCCESS] Connected to MongoDB!".green);

    const database = mongoClient.db("MorningBot");
    const miningProfilesCollection = database.collection("MiningProfiles");
    const userCoinsCollection = database.collection("UserCoins");
    const coinTransactionsCollection = database.collection("CoinTransactions");

    const fakeClient = {
      miningProfilesCollection,
      userCoinsCollection,
      coinTransactionsCollection,
    };

    const targets = await miningProfilesCollection
      .find(SOURCE_FILTER)
      .project({
        userId: 1,
        guildId: 1,
        pending_appraisal: 1,
        "backpack.stone": 1,
      })
      .toArray();

    if (targets.length === 0) {
      console.log("[INFO] 沒有任何 synthetic pending_appraisal，無需處理".yellow);
      return;
    }

    const feePerStone = mining?.stoneAppraisal?.feePerStone || 0;
    console.log(`\n[INFO] 找到 ${targets.length} 筆 synthetic pending_appraisal`.cyan);
    console.log(`[INFO] 鑑定費：${feePerStone} 幣 / 顆`.cyan);

    const balances = await userCoinsCollection
      .find({
        $or: targets.map((t) => ({ userId: t.userId, guildId: t.guildId })),
      })
      .project({ userId: 1, guildId: 1, totalCoins: 1 })
      .toArray();
    const balanceMap = new Map(
      balances.map((b) => [`${b.userId}_${b.guildId}`, b.totalCoins || 0]),
    );

    const preview = { affordable: 0, broke: 0, qtyTotal: 0, feeTotal: 0 };
    for (const t of targets) {
      const qty = Math.max(0, Math.floor(t.pending_appraisal?.qty || 0));
      const fee = feePerStone * qty;
      preview.qtyTotal += qty;
      preview.feeTotal += fee;
      const have = balanceMap.get(`${t.userId}_${t.guildId}`) || 0;
      if (have >= fee) preview.affordable++;
      else preview.broke++;
    }

    console.log("\n[預覽] 影響範圍：".cyan);
    console.log(`  待開賭石總顆數：${preview.qtyTotal}`.white);
    console.log(`  預計鑑定費總額：${preview.feeTotal.toLocaleString()} 幣`.white);
    console.log(`  餘額足夠可開：${preview.affordable} 人`.white);
    console.log(`  餘額不足將跳過：${preview.broke} 人`.white);

    if (!shouldApply) {
      console.log(
        "\n[INFO] 這是 dry-run。確認無誤後執行 `node scripts/resolvePendingStoneAppraisals.js apply`".yellow,
      );
      return;
    }

    console.log("\n[WARNING] 5 秒後開始處理，按 Ctrl+C 取消...".yellow);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const stats = {
      ok: 0,
      no_coins: 0,
      no_stone: 0,
      stale: 0,
      charge_failed: 0,
      other: 0,
    };
    const diamondHits = [];

    for (const t of targets) {
      const newTs = Date.now();
      const refresh = await miningProfilesCollection.updateOne(
        {
          userId: t.userId,
          guildId: t.guildId,
          "pending_appraisal.synthetic": true,
        },
        { $set: { "pending_appraisal.ts": newTs, updatedAt: new Date() } },
      );
      if (refresh.modifiedCount === 0) {
        stats.stale++;
        console.log(
          `  [SKIP] ${t.userId}@${t.guildId}: pending 已被清掉`.gray,
        );
        continue;
      }

      const result = await appraisalService
        .appraise(fakeClient, {
          userId: t.userId,
          guildId: t.guildId,
          member: null,
          username: null,
          ts: newTs,
          allowOverflow: true,
        })
        .catch((e) => ({ ok: false, reason: "exception", error: e }));

      if (result.ok) {
        stats.ok++;
        const oreSummary = Object.entries(result.winnings || {})
          .map(([ore, q]) => `${ore}×${q}`)
          .join("、") || "全碎";
        const overflowTag = result.overflowCoins > 0
          ? `，溢出折 ${result.overflowCoins.toLocaleString()} 幣`
          : "";
        console.log(
          `  [OK] ${t.userId}@${t.guildId}: ${result.count} 顆 → ${oreSummary}${overflowTag}（餘額 ${result.balanceAfter?.toLocaleString?.() ?? "?"}）`
            .green,
        );
        if (result.gainedDiamond) {
          diamondHits.push({
            userId: t.userId,
            guildId: t.guildId,
            qty: result.winnings.diamond,
          });
        }
      } else {
        const key = stats[result.reason] !== undefined ? result.reason : "other";
        stats[key]++;
        console.log(
          `  [FAIL/${result.reason}] ${t.userId}@${t.guildId}${result.fee ? `（要 ${result.fee} 有 ${result.balance}）` : ""}`
            .yellow,
        );
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(`[SUCCESS] 處理完成`.green);
    console.log(`  成功賭石：${stats.ok} 人`.white);
    console.log(`  餘額不足跳過：${stats.no_coins} 人`.white);
    console.log(`  無石頭可賭：${stats.no_stone} 人`.white);
    console.log(`  pending 已過期/被清：${stats.stale} 人`.white);
    console.log(`  扣款失敗：${stats.charge_failed} 人`.white);
    console.log(`  其他：${stats.other} 人`.white);
    if (diamondHits.length > 0) {
      console.log(`\n  💎 鑽石 ${diamondHits.length} 筆：`.magenta);
      for (const d of diamondHits) {
        console.log(`    ${d.userId}@${d.guildId} ×${d.qty}`.magenta);
      }
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
