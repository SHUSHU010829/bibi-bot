// 處理樂透訂閱取消按鈕。

const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { MessageFlags } = require("discord.js");
const { deferReplySafe } = require("../../utils/safeAck");

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    if (!interaction.customId?.startsWith("lotterysub_cancel_")) return;
    if (!client.lotterySubscriptionsCollection) return;

    if (!(await deferReplySafe(interaction, { flags: MessageFlags.Ephemeral }))) {
      return;
    }

    const subscriptionId = interaction.customId.slice("lotterysub_cancel_".length);
    const sub = await client.lotterySubscriptionsCollection.findOne({ subscriptionId });

    if (!sub) {
      return interaction.editReply({
        content: "找不到這筆訂閱(可能已取消)。",
      });
    }
    if (sub.userId !== interaction.user.id) {
      return interaction.editReply({
        content: "🚫 這不是你的訂閱。",
      });
    }
    if (sub.status !== "active" && sub.status !== "insufficient") {
      return interaction.editReply({
        content: "這筆訂閱已不在進行中。",
      });
    }

    await client.lotterySubscriptionsCollection.updateOne(
      { subscriptionId },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      }
    );

    await interaction.editReply({
      content: `✅ 已取消訂閱(剩餘 ${sub.drawsRemaining} 期未扣款)。`,
    });
    trackSuccess("lottery-cancel-sub");
  } catch (err) {
    logger.error(
      { source: "lottery-cancel-sub", userId: interaction.user?.id, err: err.message, stack: err.stack },
      "處理樂透訂閱取消失敗"
    );
    trackError("lottery-cancel-sub", err, { userId: interaction.user?.id });
  }
};
