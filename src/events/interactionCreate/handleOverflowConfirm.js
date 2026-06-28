// 處理「背包滿，繼續操作會把溢出折金幣」的二次確認按鈕。
//
// 路由 prefix：
//   mine_overflow_confirm_<userId>      → 重跑挖礦，allowOverflow=true
//   mine_overflow_cancel_<userId>       → 取消
//   gift_overflow_confirm_<giverId>_<recipientId>_<type>_<key>_<qty> → 重跑贈送
//   gift_overflow_cancel_<giverId>      → 取消
//
// 賭石（appraise_overflow_*）與地下城（dungeon_overflow_*）由各自既有 handler 處理。

const {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const mineCmd = require("../../commands/mining/mine");
const giveCmd = require("../../commands/mining/give");
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

    // ─── 贈送溢出確認 ─────────────────────────────────────────────────────────
    if (cid.startsWith(giveCmd.GIFT_OVERFLOW_CONFIRM_PREFIX)) {
      const rest = cid.slice(giveCmd.GIFT_OVERFLOW_CONFIRM_PREFIX.length);
      const parts = rest.split("_");
      if (parts.length < 5) return;
      const giverId = parts[0];
      const recipientId = parts[1];
      const type = parts[2];
      const qty = Number(parts[parts.length - 1]);
      const key = parts.slice(3, parts.length - 1).join("_");
      if (interaction.user.id !== giverId) {
        return replyEphemeral(interaction, "🚫 這不是你的贈送確認。");
      }
      if (!Number.isFinite(qty) || qty <= 0) return;

      if (!(await deferUpdateSafe(interaction))) return;
      const target = await client.users.fetch(recipientId).catch(() => null);
      if (!target) {
        return interaction
          .editReply({ components: [], content: "🔧 找不到收禮對象，請重新 /贈送。" })
          .catch(() => {});
      }
      return await giveCmd.executeGift(client, interaction, {
        target,
        type,
        key,
        qty,
        allowOverflow: true,
      });
    }
    if (cid.startsWith(giveCmd.GIFT_OVERFLOW_CANCEL_PREFIX)) {
      const ownerId = cid.slice(giveCmd.GIFT_OVERFLOW_CANCEL_PREFIX.length);
      if (interaction.user.id !== ownerId) {
        return replyEphemeral(interaction, "🚫 這不是你的贈送。");
      }
      return interaction
        .update({
          components: [cancelledPanel("✖️ 已取消這次贈送。")],
          flags: MessageFlags.IsComponentsV2,
        })
        .catch(() => {});
    }
  } catch (err) {
    console.log(`[ERROR] handleOverflowConfirm:\n${err}\n${err.stack}`.red);
    await replyEphemeral(interaction, "🔧 處理失敗，請呼叫舒舒！");
  }
};
