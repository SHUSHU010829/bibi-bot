require("colors");

const { serverId } = require("../../config");
const getApplicationCommands = require("../../utils/getApplicationCommands");
const getLocalCommands = require("../../utils/getLocalCommands");

module.exports = async (client) => {
  try {
    console.log("🔄 [COMMAND REGISTRY] Starting command registration...".cyan);
    const localCommands = await getLocalCommands();
    const applicationCommands = await getApplicationCommands(client, serverId);

    // 準備要註冊的指令數據
    const commandsToRegister = [];

    for (const localCommand of localCommands) {
      const { data, deleted, subcommandOnly } = localCommand;

      // 只作為母指令 subcommand 存在的模組（如 /賭場 底下的遊戲）不獨立註冊
      if (subcommandOnly) continue;

      // 將 SlashCommandBuilder 序列化為純 JSON，確保所有 option 都帶有 type 欄位
      const commandJSON =
        typeof data?.toJSON === "function" ? data.toJSON() : { ...data };
      const commandName = commandJSON.name;

      // 跳過已標記為刪除的指令
      if (deleted) {
        console.log(
          `[COMMAND REGISTRY] Skipping ${commandName} (marked as deleted)`.grey
        );
        continue;
      }

      commandsToRegister.push(commandJSON);
    }

    // 使用批量覆蓋 API - Discord 會自動處理差異（新增/更新/刪除）
    await applicationCommands.set(commandsToRegister);
    console.log(
      `✅ [COMMAND REGISTRY] Successfully registered ${commandsToRegister.length} commands (bulk update)`.green
    );

    commandsToRegister.forEach(cmd => {
      console.log(`   ✓ ${cmd.name}`.grey);
    });
  } catch (error) {
    console.log(
      `[ERROR] An error occurred inside the command registry:\n${error}`.red
    );
    if (error?.rawError) {
      console.log(
        `[ERROR] Discord API rawError:\n${JSON.stringify(error.rawError, null, 2)}`.red
      );
    }
    if (error?.requestBody) {
      console.log(
        `[ERROR] Request body json (truncated 4000):\n${JSON.stringify(error.requestBody.json).slice(0, 4000)}`.red
      );
    }
  }
};
