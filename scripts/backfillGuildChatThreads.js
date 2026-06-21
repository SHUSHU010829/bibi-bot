require("colors");
require("dotenv/config");

const { Client, GatewayIntentBits } = require("discord.js");
const { MongoClient } = require("mongodb");
const guildClubChat = require("../src/features/guild_club/guildClubChat");

/**
 * 一次性 backfill：替所有未解散的公會建立／補上聊天串。
 *
 * - 走 guildClubChat.ensureThread，本身 idempotent：
 *   - 已有 chat_thread_id 且串存在 → 直接 return（什麼都不做）
 *   - 串被封存 → 自動解封
 *   - 串被刪 / 無 chat_thread_id → 重新建立
 * - 不自動加任何成員（避免歡迎訊息洗版）；後續成員加入時的 hook 仍會正常拉人
 *
 * 用法：
 *   node scripts/backfillGuildChatThreads.js          # dry-run，只列出將被處理的公會
 *   node scripts/backfillGuildChatThreads.js apply    # 實際建串
 */

async function main() {
  const shouldApply = process.argv.includes("apply");

  if (!process.env.MONGO_URI) {
    console.log("[ERROR] MONGO_URI 未設定".red);
    process.exit(1);
  }
  if (!process.env.BOT_TOKEN) {
    console.log("[ERROR] BOT_TOKEN 未設定".red);
    process.exit(1);
  }

  const mongoClient = new MongoClient(process.env.MONGO_URI);
  await mongoClient.connect();
  console.log("[SUCCESS] MongoDB 連上".green);

  const database = mongoClient.db("MorningBot");
  const guildsClubCollection = database.collection("GuildsClub");

  const clubs = await guildsClubCollection
    .find({ disbanded_at: null })
    .toArray();

  console.log(`[INFO] 共 ${clubs.length} 個未解散公會`.cyan);
  const needCreate = clubs.filter((c) => !c.chat_thread_id);
  const haveThread = clubs.length - needCreate.length;
  console.log(`  - 已有 chat_thread_id：${haveThread} 個`);
  console.log(`  - 待新建：${needCreate.length} 個`);
  for (const c of clubs) {
    const status = c.chat_thread_id ? `串=${c.chat_thread_id}` : "（無串）";
    console.log(`  • ${c.name} [${c.guild_club_id}] ${status}`);
  }

  if (!shouldApply) {
    console.log("\n[DRY-RUN] 未執行，加 'apply' 參數真的建串：".cyan);
    console.log("  node scripts/backfillGuildChatThreads.js apply".white);
    await mongoClient.close();
    return;
  }

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await new Promise((resolve, reject) => {
    discord.once("ready", resolve);
    discord.once("error", reject);
    discord.login(process.env.BOT_TOKEN);
  });
  console.log(`[SUCCESS] Discord 登入：${discord.user.tag}`.green);

  // 把 collection 掛到 client，讓 guildClubChat 用得到（它讀 client.guildsClubCollection）
  discord.guildsClubCollection = guildsClubCollection;

  let created = 0;
  let existed = 0;
  let failed = 0;
  for (const club of clubs) {
    try {
      const before = club.chat_thread_id || null;
      const thread = await guildClubChat.ensureThread(discord, club);
      if (!thread) {
        console.log(`  ❌ ${club.name}：ensureThread 回 null`.red);
        failed += 1;
        continue;
      }
      if (before && before === thread.id) {
        console.log(`  ✓  ${club.name}：${thread.id}（既有）`.gray);
        existed += 1;
      } else {
        console.log(`  ✨ ${club.name}：${thread.id}（已建）`.green);
        created += 1;
      }
    } catch (e) {
      console.log(`  ❌ ${club.name}：${e.message}`.red);
      failed += 1;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`[完成] 新建 ${created}・既有 ${existed}・失敗 ${failed}`.green);
  console.log("=".repeat(60));

  await discord.destroy();
  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[FATAL] ${e.stack || e.message}`.red);
  process.exit(1);
});
