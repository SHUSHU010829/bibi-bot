// 補發「偵測失敗而漏發」的邀請獎勵。
//
// 背景:
//   同一邀請碼短時間內多人加入時，舊版 findUsedInvite 會因競態 / 使用次數
//   合併遞增而把部分被邀請者算成 delta=0，整個流程靜默中止 —— 邀請人沒拿到
//   獎勵，被邀請者也沒拿到歡迎金，且 InviteRecords 完全沒留下紀錄。
//   inviteCache.js 已修正未來的偵測；本腳本回填「已經漏掉」的那幾筆。
//
//   因為漏掉的 invitee 沒有任何 InviteRecord，腳本無法自動探勘是誰，必須由
//   操作者明確指定 guild / 邀請人 / 被邀請者清單。每位 invitee 會：
//     1. 若 InviteRecords 已有紀錄 → 跳過（冪等，對齊 (guildId,inviteeId) unique），
//        並印出該紀錄的 rewardGranted / cappedByDaily 方便診斷
//     2. 依 rewardFormula 重算金額（含級距遞增、每日上限），與 live 流程一致
//     3. grantCoins(source=invite_reward) 給邀請人
//     4. 補一筆 status="active" 的 InviteRecord（之後離開可正常回收）
//     5. 預設一併補發被邀請者歡迎金（--no-welcome 可關閉）
//
//   若紀錄已存在、但當初 rewardGranted=0（例如當天達每日上限、或 grantCoins
//   當下失敗），加 --repay 會針對 active 且 rewardGranted<=0 的紀錄補發邀請人
//   獎勵並回寫紀錄（不重發歡迎金，避免重複）。--repay 預設仍尊重每日上限，
//   要強制超發需再加 --ignore-daily-cap。
//
// 用法:
//   node src/scripts/backfillMissedInviteReward.js \
//     --guild=<guildId> --inviter=<inviterId> --invitees=<id1>,<id2> \
//     [--code=<inviteCode>] [--joinedAt=2026-06-01T03:43:00+08:00] \
//     [--no-welcome] [--ignore-daily-cap] [--repay] [--apply]
//
//   不加 --apply 為 dry-run（只印不寫）。

require("dotenv/config");
require("colors");

const { MongoClient } = require("mongodb");

const grantCoins = require("../features/economy/grantCoins");
const {
  computeReward,
  countActiveInvites,
  countTodayRewardedInvites,
  getDailyCap,
} = require("../features/invite/rewardFormula");
const { inviteSystem } = require("../config");

function parseArgs(argv) {
  const args = {
    apply: false,
    welcome: true,
    ignoreDailyCap: false,
    repay: false,
    guildId: null,
    inviterId: null,
    invitees: [],
    code: null,
    joinedAt: null,
  };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a === "--no-welcome") args.welcome = false;
    else if (a === "--ignore-daily-cap") args.ignoreDailyCap = true;
    else if (a === "--repay") args.repay = true;
    else if (a.startsWith("--guild=")) args.guildId = a.slice(8);
    else if (a.startsWith("--inviter=")) args.inviterId = a.slice(10);
    else if (a.startsWith("--invitees="))
      args.invitees = a
        .slice(11)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a.startsWith("--code=")) args.code = a.slice(7);
    else if (a.startsWith("--joinedAt=")) args.joinedAt = a.slice(11);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定，無法連線。".red);
    process.exit(1);
  }
  if (!args.guildId || !args.inviterId || args.invitees.length === 0) {
    console.log(
      "[ERROR] 必填參數缺失：--guild、--inviter、--invitees 至少各一。".red
    );
    console.log(
      "範例：node src/scripts/backfillMissedInviteReward.js --guild=G --inviter=RYA --invitees=A,B --apply".gray
    );
    process.exit(1);
  }
  if (args.invitees.includes(args.inviterId)) {
    console.log("[ERROR] 被邀請者清單不可包含邀請人本人。".red);
    process.exit(1);
  }

  let joinedAt = new Date();
  if (args.joinedAt) {
    const parsed = new Date(args.joinedAt);
    if (Number.isNaN(parsed.getTime())) {
      console.log(`[ERROR] --joinedAt 格式無法解析：${args.joinedAt}`.red);
      process.exit(1);
    }
    joinedAt = parsed;
  }

  const mode = args.apply ? "APPLY（會寫入）".red : "DRY-RUN（不寫入）".green;
  console.log(`\n=== 邀請獎勵補發 — ${mode} ===`.cyan);
  console.log(
    `guild=${args.guildId} inviter=${args.inviterId} 共 ${args.invitees.length} 位被邀請者\n`.gray
  );

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db("MorningBot");

  // grantCoins / rewardFormula 只需要這三個 collection
  const client = {
    userCoinsCollection: db.collection("UserCoins"),
    coinTransactionsCollection: db.collection("CoinTransactions"),
    inviteRecordsCollection: db.collection("InviteRecords"),
  };

  const dailyCap = getDailyCap();
  const welcomeAmount = Math.max(
    0,
    Math.floor(inviteSystem?.inviteeWelcomeBonus || 0)
  );

  // DB 既有基準 + 本次累加，讓 dry-run 也能正確模擬級距/上限的逐筆變化
  const dbActiveCount = await countActiveInvites(
    client,
    args.guildId,
    args.inviterId
  );
  const dbTodayRewarded = await countTodayRewardedInvites(
    client,
    args.guildId,
    args.inviterId
  );
  let addedActive = 0;
  let addedTodayRewarded = 0;

  let totalReward = 0;
  let totalWelcome = 0;
  let granted = 0;
  let skipped = 0;

  for (const inviteeId of args.invitees) {
    const existing = await client.inviteRecordsCollection
      .findOne({ guildId: args.guildId, inviteeId })
      .catch(() => null);
    if (existing) {
      const already = existing.rewardGranted || 0;
      const detail =
        `status=${existing.status}・rewardGranted=${already}` +
        `${existing.cappedByDaily ? "・cappedByDaily" : ""}` +
        `・activeCountBefore=${existing.activeCountBefore ?? "?"}`;
      const repayable =
        args.repay && existing.status === "active" && already <= 0;

      if (!repayable) {
        const hint =
          already <= 0 && existing.status === "active"
            ? "，可加 --repay 補回".yellow
            : "";
        console.log(`  - ${inviteeId} 已有紀錄（${detail}）${hint}，跳過。`.gray);
        skipped += 1;
        continue;
      }

      // 補回：紀錄已存在但當初沒入帳（rewardGranted=0，多半是當天達每日上限）。
      // 用紀錄存的 activeCountBefore 重算，金額與當初應發的一致。
      const activeCount = existing.activeCountBefore ?? 0;
      const baseAmount = computeReward(activeCount);
      let cappedByDaily = false;
      if (!args.ignoreDailyCap && dailyCap > 0) {
        if (dbTodayRewarded + addedTodayRewarded >= dailyCap) cappedByDaily = true;
      }
      const amount = cappedByDaily ? 0 : baseAmount;

      console.log(
        `  ↻ ${inviteeId} 補回（原 ${detail}）→ 邀請人 +${amount}${
          cappedByDaily ? "（今日仍達上限，維持 0，需 --ignore-daily-cap 才強發）" : ""
        }`.green
      );

      if (args.apply) {
        let rewardGranted = 0;
        if (amount > 0) {
          const res = await grantCoins(client, {
            userId: args.inviterId,
            guildId: args.guildId,
            amount,
            source: "invite_reward",
            meta: {
              inviteeId,
              inviteCode: args.code || existing.inviteCode || null,
              backfill: true,
              repay: true,
            },
          }).catch((e) => {
            console.log(`    [ERROR] grantCoins 失敗：${e.message}`.red);
            return null;
          });
          rewardGranted = res?.granted || 0;
        }
        await client.inviteRecordsCollection
          .updateOne(
            { _id: existing._id },
            { $set: { rewardGranted, cappedByDaily, backfilledAt: new Date() } }
          )
          .catch((e) =>
            console.log(`    [ERROR] 更新 InviteRecord 失敗：${e.message}`.red)
          );
        totalReward += rewardGranted;
        if (rewardGranted > 0) addedTodayRewarded += 1;
      } else {
        totalReward += amount;
        if (amount > 0) addedTodayRewarded += 1;
      }
      granted += 1;
      continue;
    }

    const activeCount = dbActiveCount + addedActive;
    const baseAmount = computeReward(activeCount);

    let cappedByDaily = false;
    if (!args.ignoreDailyCap && dailyCap > 0) {
      if (dbTodayRewarded + addedTodayRewarded >= dailyCap) cappedByDaily = true;
    }
    const amount = cappedByDaily ? 0 : baseAmount;

    console.log(
      `  + ${inviteeId} 第 ${activeCount + 1} 位 → 邀請人 +${amount}${
        cappedByDaily ? "（今日已達上限）" : ""
      }${args.welcome && welcomeAmount > 0 ? `，歡迎金 +${welcomeAmount}` : ""}`
        .green
    );

    if (args.apply) {
      let rewardGranted = 0;
      if (amount > 0) {
        const res = await grantCoins(client, {
          userId: args.inviterId,
          guildId: args.guildId,
          amount,
          source: "invite_reward",
          meta: { inviteeId, inviteCode: args.code || null, backfill: true },
        }).catch((e) => {
          console.log(`    [ERROR] grantCoins 失敗：${e.message}`.red);
          return null;
        });
        rewardGranted = res?.granted || 0;
      }

      await client.inviteRecordsCollection
        .insertOne({
          guildId: args.guildId,
          inviterId: args.inviterId,
          inviteeId,
          inviteCode: args.code || null,
          joinedAt,
          leftAt: null,
          status: "active",
          rewardGranted,
          activeCountBefore: activeCount,
          cappedByDaily,
          clawedBackAt: null,
          backfilledAt: new Date(),
        })
        .catch((e) => {
          console.log(`    [ERROR] 寫入 InviteRecord 失敗：${e.message}`.red);
        });

      if (args.welcome && welcomeAmount > 0) {
        await grantCoins(client, {
          userId: inviteeId,
          guildId: args.guildId,
          amount: welcomeAmount,
          source: "invite_welcome",
          meta: {
            inviterId: args.inviterId,
            inviteCode: args.code || null,
            backfill: true,
          },
        }).catch((e) =>
          console.log(`    [WARN] 歡迎金補發失敗：${e.message}`.yellow)
        );
      }

      totalReward += rewardGranted;
    } else {
      totalReward += amount;
    }

    if (args.welcome && welcomeAmount > 0) totalWelcome += welcomeAmount;

    // 不論 apply 與否都推進，使後續被邀請者的級距/上限與 live 行為一致
    addedActive += 1;
    if (amount > 0) addedTodayRewarded += 1;
    granted += 1;
  }

  console.log("");
  console.log(
    `處理：補發 ${granted} 位、跳過 ${skipped} 位。邀請獎勵共 ${totalReward}，歡迎金共 ${totalWelcome}。`
      .cyan
  );
  console.log(
    args.apply
      ? "已實際寫入。".green
      : "以上為預演結果，加 --apply 才會實際寫入。".yellow
  );

  await mongo.close();
}

main().catch((err) => {
  console.error("[FATAL]".red, err);
  process.exit(1);
});
