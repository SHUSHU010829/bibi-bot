require("colors");
require("dotenv/config");

const { Client, GatewayIntentBits } = require("discord.js");
const { MongoClient } = require("mongodb");
const guildClubChat = require("../src/features/guild_club/guildClubChat");

/**
 * 一次性 backfill：替所有未解散的公會建立／補上聊天串，並把現有成員拉進去。
 *
 * - 走 guildClubChat.ensureThread，本身 idempotent：
 *   - 已有 chat_thread_id 且串存在 → 直接 return（什麼都不做）
 *   - 串被封存 → 自動解封
 *   - 串被刪 / 無 chat_thread_id → 重新建立
 * - 對每個公會的所有現有成員呼叫 thread.members.add（已在串裡的會直接 no-op）
 * - **不發歡迎訊息**（避免突然洗版），只默默把人加進去
 * - 後續成員加入時的 hook 仍會正常拉人 + 發歡迎
 *
 * 用法：
 *   node scripts/backfillGuildChatThreads.js          # dry-run，只列出將被處理的公會與成員數
 *   node scripts/backfillGuildChatThreads.js apply    # 實際建串並加成員
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
  const guildClubMembersCollection = database.collection("GuildClubMembers");

  const clubs = await guildsClubCollection
    .find({ disbanded_at: null })
    .toArray();

  console.log(`[INFO] 共 ${clubs.length} 個未解散公會`.cyan);
  const needCreate = clubs.filter((c) => !c.chat_thread_id);
  const haveThread = clubs.length - needCreate.length;
  console.log(`  - 已有 chat_thread_id：${haveThread} 個`);
  console.log(`  - 待新建：${needCreate.length} 個`);

  const membersByClub = new Map();
  for (const c of clubs) {
    const ms = await guildClubMembersCollection
      .find({ guild_club_id: c.guild_club_id })
      .toArray();
    membersByClub.set(c.guild_club_id, ms);
    const status = c.chat_thread_id ? `串=${c.chat_thread_id}` : "（無串）";
    console.log(`  • ${c.name} [${c.guild_club_id}] ${status}・${ms.length} 名成員`);
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
  let memberAdds = 0;
  let memberAddFails = 0;

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

      // 把現有成員都拉進串（已在串裡的會直接 no-op；不發歡迎訊息）
      const members = membersByClub.get(club.guild_club_id) || [];
      let addedHere = 0;
      let failedHere = 0;
      for (const m of members) {
        try {
          await thread.members.add(m.userId);
          addedHere += 1;
        } catch (e) {
          failedHere += 1;
          console.log(
            `      ⚠️  加 <@${m.userId}> 失敗：${e.message}`.yellow
          );
        }
      }
      memberAdds += addedHere;
      memberAddFails += failedHere;
      console.log(
        `      └ 加成員：${addedHere} 成功 / ${failedHere} 失敗（共 ${members.length}）`.gray
      );
    } catch (e) {
      console.log(`  ❌ ${club.name}：${e.message}`.red);
      failed += 1;
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log(`[完成] 公會：新建 ${created}・既有 ${existed}・失敗 ${failed}`.green);
  console.log(`       成員：加入 ${memberAdds}・失敗 ${memberAddFails}`.green);
  console.log("=".repeat(60));

  await discord.destroy();
  await mongoClient.close();
}

main().catch((e) => {
  console.log(`[FATAL] ${e.stack || e.message}`.red);
  process.exit(1);
});
