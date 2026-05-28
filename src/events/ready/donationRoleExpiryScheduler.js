// 抖內身分組過期掃描：每 10 分鐘掃 DonationRecords 中 roleExpiresAt 已到
// 期且 roleRemoved 未設的紀錄，從玩家身上移除身分組。
//
// 設計重點：
// 1. 永久身分組（roleExpiresAt=null 或 tier.permanentRole）不會被處理
// 2. 同一玩家若有多筆未過期記錄帶同一個 role，**只有全部都過期了才會移除**
//    （例如 90 天 premium 還沒到、但 30 天 standard 已到 → 不能移除）
// 3. 永久記錄（VIP）視為「永遠最新」，會擋住同 role 的所有過期移除

require("colors");
const cron = require("node-cron");
const { donation } = require("../../config");

let task = null;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

async function sweepOnce(client) {
  if (!client.donationRecordsCollection) return 0;
  const now = new Date();

  // 拿出所有過期、未處理的記錄
  const expired = await client.donationRecordsCollection
    .find({
      roleId: { $exists: true, $ne: null },
      roleExpiresAt: { $lte: now },
      roleRemoved: { $ne: true },
    })
    .toArray();

  if (!expired.length) return 0;

  let processed = 0;
  for (const record of expired) {
    try {
      // 該玩家 + 該 role 是否還有有效（未到期或永久）的記錄？有的話保留角色
      const stillValid = await client.donationRecordsCollection.findOne({
        userId: record.userId,
        guildId: record.guildId,
        roleId: record.roleId,
        $or: [
          { roleExpiresAt: null },
          { roleExpiresAt: { $gt: now } },
        ],
      });

      if (!stillValid) {
        // 真的可以移除了
        const guild =
          client.guilds.cache.get(record.guildId) ||
          (await client.guilds.fetch(record.guildId).catch(() => null));
        if (guild) {
          const member =
            guild.members.cache.get(record.userId) ||
            (await guild.members.fetch(record.userId).catch(() => null));
          if (member && member.roles.cache.has(record.roleId)) {
            await member.roles
              .remove(record.roleId, `donation role expired: trade=${record.tradeNo}`)
              .catch((e) => {
                console.log(
                  `[DONATION] 移除身分組失敗 user=${record.userId} role=${record.roleId}: ${e.message}`.yellow,
                );
              });
            console.log(
              `[DONATION] 身分組到期移除 user=${record.userId} role=${record.roleId} trade=${record.tradeNo}`.gray,
            );
          }
        }
      }

      // 不論最後有沒有真的 .remove（可能多筆同 role 共用、不該移除），
      // 都把這筆記錄標記為已處理，避免重複掃描
      await client.donationRecordsCollection.updateOne(
        { _id: record._id },
        {
          $set: {
            roleRemoved: true,
            roleRemovedAt: now,
            roleStillValid: !!stillValid,
          },
        },
      );
      processed += 1;
    } catch (err) {
      console.log(
        `[ERROR] donation role expire trade=${record.tradeNo}: ${err.message}`.red,
      );
    }
  }
  return processed;
}

module.exports = async (client) => {
  if (!donation?.enabled) return;
  if (task) return;

  task = cron.schedule("*/10 * * * *", async () => {
    try {
      const processed = await sweepOnce(client);
      if (processed > 0) {
        console.log(`[DONATION] 身分組過期掃描：處理 ${processed} 筆`.gray);
      }
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.log(
        `[ERROR] donationRoleExpiryScheduler failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):\n${err}`.red,
      );
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.log(`[ERROR] 連續錯誤過多，停止抖內身分組過期掃描 cron`.red);
        task.stop();
      }
    }
  });

  console.log(`[DONATION] 身分組過期掃描排程已啟動（每 10 分鐘）`.cyan);
};
