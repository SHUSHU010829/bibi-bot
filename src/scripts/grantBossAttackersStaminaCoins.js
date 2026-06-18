// 補發「打過最近一場 boss」的玩家等值體力藥水的金幣（預設 1800 = 3 罐 × 600）。
//
// 用法:
//   node src/scripts/grantBossAttackersStaminaCoins.js               # dry-run
//   node src/scripts/grantBossAttackersStaminaCoins.js --apply       # 實際寫入
//   node src/scripts/grantBossAttackersStaminaCoins.js --apply --boss-id=boss_xxx_123
//   node src/scripts/grantBossAttackersStaminaCoins.js --apply --per-user=2400
//
// 行為:
//   1. 找最新一場已結算的 boss（status in [defeated, expired]，按 settled_at 倒序）
//   2. 從 BossDamageLogs 取出所有 distinct 攻擊者 user_id
//   3. 每人 +PER_USER 幣，source=admin、meta 註記 boss_id 與 reason
//   4. boss 文件加 stamina_compensation_at 標記避免重複發放（冪等）

require("dotenv/config");
require("colors");

const { MongoClient } = require("mongodb");
const { DateTime } = require("luxon");

const { coinSystem } = require("../config");

const DEFAULT_PER_USER = 1800;

function parseArgs(argv) {
  const args = { apply: false, bossId: null, perUser: DEFAULT_PER_USER };
  for (const a of argv.slice(2)) {
    if (a === "--apply") args.apply = true;
    else if (a.startsWith("--boss-id=")) args.bossId = a.slice("--boss-id=".length);
    else if (a.startsWith("--per-user=")) args.perUser = Math.floor(Number(a.slice("--per-user=".length)) || 0);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定，無法連線。".red);
    process.exit(1);
  }
  if (!args.perUser || args.perUser <= 0) {
    console.log("[ERROR] --per-user 必須為正整數".red);
    process.exit(1);
  }

  const mode = args.apply ? "APPLY（會寫入）".red : "DRY-RUN（不寫入）".green;
  console.log(`\n=== Boss 攻擊者體力藥水補償 — ${mode} ===\n`.cyan);

  const mongo = new MongoClient(process.env.MONGO_URI);
  await mongo.connect();
  const db = mongo.db("MorningBot");

  const BossEvents = db.collection("BossEvents");
  const BossDamageLogs = db.collection("BossDamageLogs");
  const UserCoins = db.collection("UserCoins");
  const CoinTx = db.collection("CoinTransactions");

  const bossFilter = args.bossId
    ? { boss_id: args.bossId }
    : { status: { $in: ["defeated", "expired"] }, settled_at: { $exists: true } };
  const boss = await BossEvents.findOne(bossFilter, { sort: { settled_at: -1 } });
  if (!boss) {
    console.log("沒找到符合條件的 boss。".yellow);
    await mongo.close();
    return;
  }

  const settledAt = boss.settled_at ? new Date(boss.settled_at).toISOString() : "(未結算)";
  console.log(
    `目標 boss: ${boss.name} ${boss.emoji} (${boss.boss_id})  status=${boss.status}  settled_at=${settledAt}`.yellow,
  );

  if (boss.stamina_compensation_at) {
    console.log(
      `⚠ 這場 boss 已於 ${new Date(boss.stamina_compensation_at).toISOString()} 補償過，再跑會重發。`.red,
    );
    if (args.apply) {
      console.log("  → 為防呆，--apply 模式直接中止。如真的要重發請手動清掉 stamina_compensation_at。".red);
      await mongo.close();
      return;
    }
  }

  const attackerIds = await BossDamageLogs.distinct("user_id", { boss_id: boss.boss_id });
  if (attackerIds.length === 0) {
    console.log("這場 boss 沒有任何攻擊紀錄。".yellow);
    await mongo.close();
    return;
  }

  // 給每位攻擊者抓一個 username（取最後一筆 log 的 username）
  const latestLogs = await BossDamageLogs
    .find({ boss_id: boss.boss_id, user_id: { $in: attackerIds } })
    .sort({ ts: -1 })
    .toArray();
  const usernameByUser = new Map();
  for (const l of latestLogs) {
    if (!usernameByUser.has(l.user_id) && l.username) usernameByUser.set(l.user_id, l.username);
  }

  console.log(`攻擊者人數: ${attackerIds.length}  每人 +${args.perUser} 幣  總支出 ${attackerIds.length * args.perUser} 幣\n`.cyan);

  const tz = coinSystem?.daily?.resetTimezone || "Asia/Taipei";
  const today = DateTime.now().setZone(tz).toISODate();
  const now = new Date();

  for (const userId of attackerIds) {
    const name = usernameByUser.get(userId) || "(unknown)";
    console.log(`  + ${userId}  ${name}  +${args.perUser}`.green);
    if (args.apply) {
      const coinSet = { updatedAt: now };
      if (name && name !== "(unknown)") coinSet.username = name;
      await UserCoins.updateOne(
        { userId, guildId: boss.guild_id },
        {
          $inc: {
            totalCoins: args.perUser,
            lifetimeCoins: args.perUser,
            coinsFrom_admin: args.perUser,
          },
          $setOnInsert: {
            userId,
            guildId: boss.guild_id,
            createdAt: now,
          },
          $set: coinSet,
        },
        { upsert: true },
      );
      await CoinTx.insertOne({
        userId,
        guildId: boss.guild_id,
        amount: args.perUser,
        source: "admin",
        meta: {
          reason: "boss_stamina_potion_compensation",
          bossId: boss.boss_id,
          bossName: boss.name,
          potions: 3,
        },
        date: today,
        createdAt: now,
      });
    }
  }

  if (args.apply) {
    await BossEvents.updateOne(
      { boss_id: boss.boss_id },
      { $set: { stamina_compensation_at: now } },
    );
    console.log(`\n✓ 已發放完成，並在 boss 文件標記 stamina_compensation_at。`.cyan);
  } else {
    console.log(`\n(dry-run) 不會寫入。確認名單後加 --apply 再跑一次。`.gray);
  }

  await mongo.close();
}

main().catch((e) => {
  console.log(`[FATAL] ${e?.stack || e}`.red);
  process.exit(1);
});
