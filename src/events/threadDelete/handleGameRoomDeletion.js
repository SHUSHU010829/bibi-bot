require("colors");

const { isGameRoom, closeRoom } = require("../../features/gameRoom/service");

module.exports = async (client, thread) => {
  try {
    if (!thread?.id || !isGameRoom(thread.id)) return;
    await closeRoom(client, thread.id, { reason: "thread_deleted" });
    console.log(`[GAMEROOM] thread ${thread.id} 被刪 → 遊戲房標記關閉`.cyan);
  } catch (err) {
    console.log(`[ERROR] handleGameRoomDeletion:\n${err}\n${err.stack}`.red);
  }
};
