require("colors");

const { join } = require("path");
const getAllFiles = require("../utils/getAllFiles");

module.exports = (client) => {
  const eventFolders = getAllFiles(join(__dirname, "..", "events"), true);

  for (const eventFolder of eventFolders) {
    const eventFiles = getAllFiles(eventFolder).sort(); // 確保按字母順序執行
    let eventName;

    eventName = eventFolder.replace(/\\/g, "/").split("/").pop();

    eventName === "validations" ? (eventName = "interactionCreate") : eventName;

    // discord.js 在新版會同時 emit 舊的 "ready" 跟 "clientReady"，所以這個
    // listener 若用 client.on 會被觸發兩次，造成 connectDb 同時跑兩條連線、
    // 而 suggestionScheduler 等後段 handler 可能在 connectDb 完成前先 race
    // 進 loadPanels（client.suggestionPanelsCollection 仍是 undefined → 噴
    // 警告）。ready 只要跑一次，所以改用 once。
    const register = eventName === "ready" ? "once" : "on";
    client[register](eventName, async (...args) => {
      for (const eventFile of eventFiles) {
        const eventFunction = require(eventFile);
        if (typeof eventFunction === "function") {
          try {
            await eventFunction(client, ...args);
          } catch (err) {
            // 單一 handler 失敗不該讓整個 client 進 'error' 事件而 crash
            console.error(
              `[ERROR] event ${eventName} handler ${eventFile} threw:`.red,
              err,
            );
          }
        } else {
          console.log(
            `[ERROR] File ${eventFile} does not export a function`.red
          );
        }
      }
    });
  }
};
