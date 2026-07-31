require("colors");
const { MessageFlags } = require("discord.js");

const deepMineCommand = require("../../commands/mining/deepMine");
const { deferUpdateSafe } = require("../../utils/safeAck");

const PREFIX = "deepmine_again_";

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith(PREFIX)) return;

  const ownerId = interaction.customId.slice(PREFIX.length);
  if (interaction.user.id !== ownerId) {
    return interaction.reply({
      content: "❌ 這不是你的深挖！用 `/深挖` 開自己的～",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await deferUpdateSafe(interaction))) return;
  try {
    // 直接重跑指令：deferUpdate 後 editReply 會覆蓋原訊息，等同「再挖一次」
    await deepMineCommand.execute(client, interaction);
  } catch (err) {
    console.log(`[ERROR] deepmine_again handler:\n${err}\n${err.stack}`.red);
  }
};
