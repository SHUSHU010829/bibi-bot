require("colors");
const { MessageFlags } = require("discord.js");
const { deferUpdateSafe } = require("../../utils/safeAck");
const pendingTransferService = require("../../features/economy/pendingTransferService");
const {
  ACCEPT_PREFIX,
  REJECT_PREFIX,
  CANCEL_PREFIX,
  buildAcceptedContainer,
  buildRefundContainer,
  buildSettledContainer,
  FAIL_COLOR,
} = require("../../features/economy/pendingTransferView");

// 待收轉帳 / 贈送按鈕：
//   ptx_accept_<recipientId>_<offerId>  → 收下（限收件方）
//   ptx_reject_<recipientId>_<offerId>  → 拒收（限收件方）
//   ptx_cancel_<senderId>_<offerId>     → 取消（限寄件方）

function parse(cid, prefix) {
  const rest = cid.slice(prefix.length);
  const i = rest.indexOf("_");
  if (i < 0) return null;
  return { authorizedId: rest.slice(0, i), offerId: rest.slice(i + 1) };
}

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

function dm(client, userId, payload) {
  client.users
    .fetch(userId)
    .then((u) => u.send(payload))
    .catch(() => {});
}

async function editSettled(interaction, container) {
  await interaction
    .editReply({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [] },
    })
    .catch(() => {});
}

module.exports = async (client, interaction) => {
  if (!interaction.isButton()) return;
  const cid = interaction.customId || "";

  let action = null;
  let prefix = null;
  if (cid.startsWith(ACCEPT_PREFIX)) { action = "accept"; prefix = ACCEPT_PREFIX; }
  else if (cid.startsWith(REJECT_PREFIX)) { action = "reject"; prefix = REJECT_PREFIX; }
  else if (cid.startsWith(CANCEL_PREFIX)) { action = "cancel"; prefix = CANCEL_PREFIX; }
  else return;

  try {
    const parsed = parse(cid, prefix);
    if (!parsed) return;
    const { authorizedId, offerId } = parsed;

    if (interaction.user.id !== authorizedId) {
      const msg =
        action === "cancel"
          ? "🚫 只有寄件方能取消這筆邀請。"
          : "🚫 這不是給你的邀請，無法收下 / 拒收。";
      return replyEphemeral(interaction, msg);
    }

    if (!(await deferUpdateSafe(interaction))) return;

    if (action === "accept") {
      const res = await pendingTransferService.acceptOffer(client, {
        offerId,
        actorUser: interaction.user,
        actorMember: interaction.member,
      });
      if (!res.ok) {
        if (res.reason === "gone") return replyEphemeral(interaction, "這筆邀請已被處理或不存在了。");
        if (res.reason === "expired") {
          if (res.offer) await editSettled(interaction, buildRefundContainer(res.offer, "expired"));
          return;
        }
        await editSettled(
          interaction,
          buildSettledContainer({ color: FAIL_COLOR, title: "🔧 收下失敗", body: "入帳時發生問題，物品 / 金幣已退回寄件方，請稍後再試。" })
        );
        return;
      }
      await editSettled(interaction, buildAcceptedContainer(res));
      dm(client, res.offer.sender_id, {
        content:
          res.kind === "coin"
            ? `✅ <@${res.offer.recipient_id}> 已收下你轉的 ${res.offer.amount.toLocaleString()} 金幣。`
            : `✅ <@${res.offer.recipient_id}> 已收下你送的禮物。`,
      });
      return;
    }

    if (action === "reject") {
      const res = await pendingTransferService.rejectOffer(client, { offerId });
      if (!res.ok) return replyEphemeral(interaction, "這筆邀請已被處理或不存在了。");
      await editSettled(interaction, buildRefundContainer(res.offer, "rejected"));
      dm(client, res.offer.sender_id, {
        content: `✋ <@${res.offer.recipient_id}> 拒收了你的${res.offer.kind === "coin" ? "轉帳" : "贈送"}，已全額退回你的帳戶。`,
      });
      return;
    }

    // cancel
    const res = await pendingTransferService.cancelOffer(client, { offerId });
    if (!res.ok) return replyEphemeral(interaction, "這筆邀請已被處理或不存在了。");
    await editSettled(interaction, buildRefundContainer(res.offer, "cancelled"));
  } catch (error) {
    console.log(`[ERROR] handlePendingTransferButton:\n${error}\n${error.stack}`.red);
    await replyEphemeral(interaction, "🔧 處理失敗，請呼叫舒舒！");
  }
};
