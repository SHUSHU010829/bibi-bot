require("colors");
const { MessageFlags } = require("discord.js");
const { registerCron } = require("../../utils/cronRegistry");
const pendingTransferService = require("../../features/economy/pendingTransferService");
const { buildRefundContainer } = require("../../features/economy/pendingTransferView");

// 每 5 分鐘掃過期的待收轉帳 / 贈送：逾時未答覆 → 退回寄件方、編輯原訊息移除按鈕、DM 通知雙方。

async function editOriginalMessage(client, offer) {
  if (!offer.channel_id || !offer.message_id) return;
  try {
    const channel =
      client.channels.cache.get(offer.channel_id) ||
      (await client.channels.fetch(offer.channel_id).catch(() => null));
    if (!channel) return;
    const message = await channel.messages.fetch(offer.message_id).catch(() => null);
    if (!message) return;
    await message.edit({
      components: [buildRefundContainer(offer, "expired")],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [] },
    });
  } catch (_) {
    /* 訊息可能已被刪，靜默 */
  }
}

function dm(client, userId, content) {
  client.users
    .fetch(userId)
    .then((u) => u.send({ content }))
    .catch(() => {});
}

async function sweepOnce(client) {
  const expired = await pendingTransferService.sweepExpired(client);
  for (const offer of expired) {
    await editOriginalMessage(client, offer);
    const label = offer.kind === "coin" ? "轉帳" : "贈送";
    dm(client, offer.sender_id, `⌛ <@${offer.recipient_id}> 未在 24 小時內回覆你的${label}，已全額退回你的帳戶。`);
  }
  const reminded = await pendingTransferService.sweepReminders(client);
  return { expired: expired.length, reminded };
}

module.exports = async (client) => {
  registerCron(client, {
    name: "pendingTransfer.expiry",
    label: "待收轉帳／贈送逾時退回＋提醒",
    schedule: "*/5 * * * *",
    runner: () => sweepOnce(client),
  });
};
