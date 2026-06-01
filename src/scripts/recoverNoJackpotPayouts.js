// 補發「頭獎從缺時被吃掉的二/三獎」。
//
// 背景:
//   舊版 calculatePayout649 在頭獎沒人中時把整個彩池(含 2nd/3rd share)整包滾下期,
//   二/三獎玩家的 ticket 雖然有 prize="second/third",但 payoutAmount=0、grantCoins 也沒跑。
//   payout.js 已改成:頭獎從缺時頭獎 share 滾下期、二/三獎照常按 share 分配。
//   本腳本回填過去已 settled 的受影響期次:
//     1. 重算 second/third payout
//     2. 對每張受影響的票 grantCoins、改寫 payoutAmount
//     3. 更新該期 payout.second/third 和 rolledOver
//     4. 若該期滾入的下一期還是 open,扣回對應金額(避免雙重支付)
//     5. 同步 wheels.totalWon 和 subscriptions.totalWon
//     6. draw 標記 noJackpotRecoveryAppliedAt(冪等)
//
// 用法:
//   node src/scripts/recoverNoJackpotPayouts.js              # dry-run
//   node src/scripts/recoverNoJackpotPayouts.js --apply      # 實際寫入
//   node src/scripts/recoverNoJackpotPayouts.js --apply --draw=20260517-6_49

require("dotenv/config");
require("colors");

const { MongoClient } = require("mongodb");
const { DateTime } = require("luxon");

const { calculatePayout649 } = require("../features/casino/lottery/payout");
const { casino, coinSystem } = require("../config");

function parseArgs(argv) {
  const args = { apply: false, drawId: null };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--draw=")) args.drawId = a.slice(7);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定,無法連線。".red);
    process.exit(1);
  }

  const mode = args.apply ? "APPLY(會寫入)".red : "DRY-RUN(不寫入)".green;
  console.log(`\n=== 樂透二/三獎補發 — ${mode} ===\n`.cyan);

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db("MorningBot");

  const Draws = db.collection("LotteryDraws");
  const Tickets = db.collection("LotteryTickets");
  const Wheels = db.collection("LotteryWheels");
  const Subs = db.collection("LotterySubscriptions");
  const UserCoins = db.collection("UserCoins");
  const CoinTx = db.collection("CoinTransactions");

  // 找頭獎從缺、尚未補發過的 settled 期
  const drawFilter = {
    lotteryType: "6_49",
    status: "settled",
    "payout.jackpot.winnerCount": 0,
    noJackpotRecoveryAppliedAt: { $exists: false },
  };
  if (args.drawId) drawFilter.drawId = args.drawId;

  const draws = await Draws.find(drawFilter).sort({ drawNumber: 1 }).toArray();
  if (draws.length === 0) {
    console.log("沒有需要補發的期次。".green);
    await mongo.close();
    return;
  }

  const fourthPrizeFixed = casino?.lottery?.types?.["6_49"]?.fourthPrizeFixed ?? 100;
  let totalPaidOut = 0;

  for (const draw of draws) {
    console.log(`期 ${draw.drawNumber}(${draw.drawId})pool=${draw.pool}`.yellow);

    const tickets = await Tickets.find({ drawId: draw.drawId }).toArray();
    const ticketMatched = tickets.map((t) => ({
      ticketId: t.ticketId,
      matched: t.matched || 0,
    }));
    const recomputed = calculatePayout649({
      pool: draw.pool,
      fourthPrizeFixed,
      tickets: ticketMatched,
    });

    const secondPerWinner = recomputed.prizes.second.perWinner;
    const thirdPerWinner = recomputed.prizes.third.perWinner;
    const secondPayout = recomputed.prizes.second.amount;
    const thirdPayout = recomputed.prizes.third.amount;
    const newRolledOver = recomputed.prizes.rolledOver.amount;
    const totalAdded = secondPayout + thirdPayout;

    console.log(
      `  二獎:${recomputed.prizes.second.winnerCount} 位 × ${secondPerWinner}(總 ${secondPayout})`.gray,
    );
    console.log(
      `  三獎:${recomputed.prizes.third.winnerCount} 位 × ${thirdPerWinner}(總 ${thirdPayout})`.gray,
    );
    console.log(
      `  rolledOver:${draw.payout?.rolledOver?.amount ?? "?"} → ${newRolledOver}(下期扣 ${totalAdded})`.gray,
    );

    if (totalAdded === 0) {
      console.log(`  → 二/三獎都沒人中(或全 0),只標記 marker。`.gray);
      if (args.apply) {
        await Draws.updateOne(
          { _id: draw._id },
          { $set: { noJackpotRecoveryAppliedAt: new Date() } },
        );
      }
      continue;
    }

    // ── 1. 補發每張受影響的票 ────────────────────────────────────────
    const affected = tickets.filter(
      (t) => (t.prize === "second" || t.prize === "third") && !(t.payoutAmount > 0),
    );

    for (const t of affected) {
      const per = t.prize === "second" ? secondPerWinner : thirdPerWinner;
      if (per <= 0) continue;
      console.log(
        `    + ${t.prize} → user=${t.userId} ${t.numbers.join(",")} = ${per}`.green,
      );
      if (args.apply) {
        // a) ticket payoutAmount
        await Tickets.updateOne(
          { ticketId: t.ticketId },
          { $set: { payoutAmount: per } },
        );
        // b) UserCoins + CoinTransactions(對齊 grantCoins 的 payout 路徑;
        //    payout source 不走倍率/每日上限,直接 $inc)
        const now = new Date();
        const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
        const today = DateTime.now().setZone(tz).toISODate();
        const coinSet = { updatedAt: now };
        if (t.username) coinSet.username = t.username;
        await UserCoins.updateOne(
          { userId: t.userId, guildId: t.guildId },
          {
            $inc: {
              totalCoins: per,
              lifetimeCoins: per,
              coinsFrom_payout: per,
            },
            $setOnInsert: {
              userId: t.userId,
              guildId: t.guildId,
              createdAt: now,
            },
            $set: coinSet,
          },
          { upsert: true },
        );
        await CoinTx.insertOne({
          userId: t.userId,
          guildId: t.guildId,
          amount: per,
          source: "payout",
          meta: {
            game: "lottery",
            lotteryType: draw.lotteryType,
            drawId: draw.drawId,
            ticketId: t.ticketId,
            prize: t.prize,
            matched: t.matched,
            recovery: "no-jackpot-2nd-3rd-payout",
          },
          date: today,
          createdAt: now,
        });
      }
    }

    // ── 2. 包牌彙總 totalWon 同步 ────────────────────────────────────
    const wheelingIds = new Set(
      affected.map((t) => t.wheelingId).filter(Boolean),
    );
    for (const wid of wheelingIds) {
      const inc = affected
        .filter((t) => t.wheelingId === wid)
        .reduce(
          (sum, t) =>
            sum + (t.prize === "second" ? secondPerWinner : thirdPerWinner),
          0,
        );
      if (inc <= 0) continue;
      console.log(`    包牌 ${wid} totalWon +${inc}`.gray);
      if (args.apply) {
        await Wheels.updateOne({ wheelingId: wid }, { $inc: { totalWon: inc } });
      }
    }

    // ── 3. 訂閱 totalWon 同步 ────────────────────────────────────────
    const subIds = new Set(affected.map((t) => t.subscriptionId).filter(Boolean));
    for (const sid of subIds) {
      const inc = affected
        .filter((t) => t.subscriptionId === sid)
        .reduce(
          (sum, t) =>
            sum + (t.prize === "second" ? secondPerWinner : thirdPerWinner),
          0,
        );
      if (inc <= 0) continue;
      console.log(`    訂閱 ${sid} totalWon +${inc}`.gray);
      if (args.apply) {
        await Subs.updateOne({ subscriptionId: sid }, { $inc: { totalWon: inc } });
      }
    }

    // ── 4. 更新 draw payout 文件 ─────────────────────────────────────
    if (args.apply) {
      await Draws.updateOne(
        { _id: draw._id },
        {
          $set: {
            "payout.second": recomputed.prizes.second,
            "payout.third": recomputed.prizes.third,
            "payout.rolledOver.amount": newRolledOver,
            noJackpotRecoveryAppliedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );
    }

    // ── 5. 扣回下一期彩池(僅當下一期還是 open) ──────────────────────
    const nextDrawId = draw.payout?.rolledOver?.toDrawId;
    if (nextDrawId) {
      const nextDraw = await Draws.findOne({ drawId: nextDrawId });
      if (!nextDraw) {
        console.log(`    ⚠ 下期 ${nextDrawId} 不存在,跳過 pool 調整。`.yellow);
      } else if (nextDraw.status !== "open") {
        console.log(
          `    ⚠ 下期 ${nextDrawId} status=${nextDraw.status}(非 open),不動 pool,請人工確認。`.yellow,
        );
      } else {
        console.log(
          `    下期 ${nextDrawId} pool ${nextDraw.pool} → ${nextDraw.pool - totalAdded}`.gray,
        );
        if (args.apply) {
          await Draws.updateOne(
            { drawId: nextDrawId },
            {
              $inc: { pool: -totalAdded },
              $set: { updatedAt: new Date() },
            },
          );
        }
      }
    }

    totalPaidOut += totalAdded;
    console.log("");
  }

  console.log(
    args.apply
      ? `完成:處理 ${draws.length} 期,共補發 ${totalPaidOut} credits。`.green
      : `以上為預演結果,加 --apply 才會實際寫入。`.yellow,
  );

  await mongo.close();
}

main().catch((err) => {
  console.error("[FATAL]".red, err);
  process.exit(1);
});
