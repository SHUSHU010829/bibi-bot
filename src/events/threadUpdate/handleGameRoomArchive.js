require("colors");

const { isGameRoom, closeRoom } = require("../../features/gameRoom/service");

// 24 小時自動封存（或有人手動封存）→ 視同關房。
// closeRoom 自己觸發的封存不會進到這裡：cache 在封存前就已移除。
module.exports = async (client, oldThread, newThread) => {
  try {
    if (!newThread?.id || !isGameRoom(newThread.id)) return;
    if (oldThread.archived || !newThread.archived) return;
    await closeRoom(client, newThread.id, { reason: "archived" });
    console.log(`[GAMEROOM] thread ${newThread.id} 封存 → 遊戲房標記關閉`.cyan);
  } catch (err) {
    console.log(`[ERROR] handleGameRoomArchive:\n${err}\n${err.stack}`.red);
  }
};
