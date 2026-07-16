// 處理「背包滿，繼續操作會把溢出折金幣」的二次確認按鈕。
//
// 路由 prefix：
//   mine_overflow_confirm_<userId>      → 重跑挖礦，allowOverflow=true
//   mine_overflow_cancel_<userId>       → 取消
//
// 賭石（appraise_overflow_*）與地下城（dungeon_overflow_*）由各自既有 handler 處理。
// 贈送改為「待收 / 可拒收」流程，溢出在收下時自動折金幣，不再走這裡的二次確認。

const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const mineCmd = require("../../commands/mining/mine");
const { deferUpdateSafe } = require("../../utils/safeAck");

async function replyEphemeral(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (_) {
    /* noop */
  }
}

function cancelledPanel(text) {
  return new ContainerBuilder()
    .setAccentColor(0x95a5a6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";

  try {
    // ─── 挖礦溢出確認 ─────────────────────────────────────────────────────────
    if (cid.startsWith(mineCmd.MINE_OVERFLOW_CONFIRM_PREFIX)) {
      const ownerId = cid.slice(mineCmd.MINE_OVERFLOW_CONFIRM_PREFIX.length);
      if (interaction.user.id !== ownerId) {
        return replyEphemeral(interaction, "🚫 這不是你的挖礦。");
      }
      if (!(await deferUpdateSafe(interaction))) return;
      return await mineCmd.executeMine(client, interaction, { allowOverflow: true });
    }
    if (cid.startsWith(mineCmd.MINE_OVERFLOW_CANCEL_PREFIX)) {
      const ownerId = cid.slice(mineCmd.MINE_OVERFLOW_CANCEL_PREFIX.length);
      if (interaction.user.id !== ownerId) {
        return replyEphemeral(interaction, "🚫 這不是你的挖礦。");
      }
      return interaction
        .update({
          components: [cancelledPanel("✖️ 已取消這次挖礦。")],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    }
  } catch (err) {
    console.log(`[ERROR] handleOverflowConfirm:\n${err}\n${err.stack}`.red);
    await replyEphemeral(interaction, "🔧 處理失敗，請呼叫舒舒！");
  }
};
