require("colors");

const { registerCron } = require("../../utils/cronRegistry");
const theftService = require("../../features/theft/theftService");
const theftBoard = require("../../features/theft/theftBoard");

// 每分鐘掃到期的通緝：退回託管賞金、惡名 −1、標記 expired（潛伏成功）。
async function sweepOnce(client) {
  if (!client.wantedListCollection) return { expired: 0 };

  // 先撿回逾時未完成的逃亡（還原成通緝），再一併掃到期
  const reverted = await theftService.revertStaleFlee(client).catch(() => 0);
  if (reverted) console.log(`[THEFT] 逃亡逾時還原成通緝：${reverted} 筆`.gray);

  const now = new Date();
  const cursor = client.wantedListCollection.find({
    status: "wanted",
    expires_at: { $lte: now },
  });

  let expired = 0;
  while (await cursor.hasNext()) {
    const wanted = await cursor.next();
    try {
      const didExpire = await theftService.expireWanted(client, wanted);
      if (didExpire) {
        expired += 1;
        console.log(`[THEFT] 通緝時效到期洗白：user=${wanted.userId}`.gray);
      }
    } catch (e) {
      console.log(`[ERROR] theft expiry handle ${wanted.userId}: ${e}`.red);
    }
  }
  // 每分鐘重繪置頂看板：處理「時效到期 / 躲藏冷卻結束」這類沒有玩家事件的狀態變化
  await theftBoard.refresh(client);
  return { expired };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "theft.expiry",
    label: "通緝時效洗白",
    schedule: "* * * * *",
    runner: () => sweepOnce(client),
  });
  // 啟動時先建立 / 更新一次看板
  theftBoard.refresh(client).catch(() => {});
};
