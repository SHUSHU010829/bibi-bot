require("colors");

const { registerCron } = require("../../utils/cronRegistry");

// 每 30 分鐘從 userCoinsCollection.activeBuffs 移除已過期項目，避免 array 無限膨脹。
// 過期 buff 在讀取（getActiveBuffMultiplier）時本來就會被忽略，這個 job 只處理儲存清理。

async function sweepOnce(client) {
  if (!client.userCoinsCollection) return { cleaned: 0 };

  const now = new Date();
  const result = await client.userCoinsCollection.updateMany(
    { "activeBuffs.expiresAt": { $lt: now } },
    {
      $pull: { activeBuffs: { expiresAt: { $lt: now } } },
      $set: { updatedAt: now },
    },
  );

  if (result.modifiedCount > 0) {
    console.log(
      `[BUFFS] 清掉過期 activeBuffs：${result.modifiedCount} 位玩家`.gray,
    );
  }
  return { cleaned: result.modifiedCount || 0 };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "buffs.activeCleanup",
    label: "過期 buffs 清理",
    schedule: "*/30 * * * *",
    runner: () => sweepOnce(client),
  });
};
