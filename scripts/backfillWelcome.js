require("colors");
require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const sendWelcomeNotice = require("../src/features/invite/sendWelcome");

/**
 * 補發歡迎 embed（公告頻道）。
 *
 * 用途：當 bot 沒能偵測到邀請來源（vanity / ambiguous / 偵測失敗）導致歡迎
 *      embed 沒發出時，手動補發給指定成員。
 *
 * 用法：
 *   node scripts/backfillWelcome.js <guildId> <userId> [<userId> ...]
 *
 * 範例：
 *   node scripts/backfillWelcome.js 1174352637295067157 956364941080821790
 */

async function main() {
  const [, , guildId, ...userIds] = process.argv;

  if (!guildId || userIds.length === 0) {
    console.log("[ERROR] 用法: node scripts/backfillWelcome.js <guildId> <userId> [<userId> ...]".red);
    process.exit(1);
  }
  if (!process.env.BOT_TOKEN) {
    console.log("[ERROR] BOT_TOKEN 環境變數未設定".red);
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await new Promise((resolve, reject) => {
    client.once("clientReady", resolve);
    client.once("error", reject);
    client.login(process.env.BOT_TOKEN).catch(reject);
  });

  console.log(`[INFO] 已登入：${client.user.tag}`.cyan);

  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      console.log(`[ERROR] 抓不到 guild ${guildId}`.red);
      return;
    }

    for (const userId of userIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        console.log(`[WARN] 抓不到成員 ${userId}，略過`.yellow);
        continue;
      }
      await sendWelcomeNotice(client, {
        guild,
        member,
        invitee: member.user,
        inviter: null,
        welcomeAmount: 0,
        inviterReward: 0,
        activeCount: 0,
        cappedByDaily: false,
      });
      console.log(`[SUCCESS] 已補發 ${member.user.username} (${userId})`.green);
    }
  } catch (e) {
    console.log(`[ERROR] ${e.message}\n${e.stack}`.red);
  } finally {
    await client.destroy();
    process.exit(0);
  }
}

main();
