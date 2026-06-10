require("colors");
const { MessageFlags, PermissionFlagsBits } = require("discord.js");

const {
  CLOSE_PREFIX,
  isGameRoom,
  closeRoom,
} = require("../../features/gameRoom/service");

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";
  if (!cid.startsWith(CLOSE_PREFIX)) return;

  try {
    const ownerId = cid.slice(CLOSE_PREFIX.length);
    const isAdmin = interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    );
    if (interaction.user.id !== ownerId && !isAdmin) {
      return interaction.reply({
        content: "🚫 這不是你的遊戲房！",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!isGameRoom(interaction.channelId)) {
      return interaction.reply({
        content: "這間遊戲房已經關閉了。",
        flags: MessageFlags.Ephemeral,
      });
    }

    // 先回覆再封存，避免討論串鎖住後訊息發不出去
    await interaction.reply(
      `🚪 遊戲房已由 <@${interaction.user.id}> 關閉，討論串將鎖定並封存。`
    );
    await closeRoom(client, interaction.channelId, {
      closedBy: interaction.user.id,
      reason: "button",
    });
  } catch (err) {
    console.log(`[ERROR] handleGameRoomButton:\n${err}\n${err.stack}`.red);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 關房失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 關房失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) { /* noop */ }
  }
};
