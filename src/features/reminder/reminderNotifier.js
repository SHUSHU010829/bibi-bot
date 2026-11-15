require("colors");
const { MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder } = require("discord.js");

const { reminder: cfg } = require("../../config");
const { buildDeliveryContainer, buildGroupMessage, ts } = require("./reminderView");

const CANNOT_DM = 50007;

// 私訊優先；對方關閉私訊時（且設定允許）退回建立提醒的頻道 @ 本人。
async function sendDelivery(client, d) {
  const userId = d.participant.userId;
  const guildName = client.guilds.cache.get(d.reminder.guildId)?.name;
  const user = await client.users.fetch(userId).catch(() => null);
  if (user) {
    try {
      await user.send({
        components: [buildDeliveryContainer(d, { guildName })],
        flags: MessageFlags.IsComponentsV2,
      });
      return "dm";
    } catch (e) {
      if (e?.code !== CANNOT_DM) {
        console.log(`[REMINDER] 私訊失敗 ${d.reminder._id}/${userId}：${e?.message || e}`.yellow);
      }
    }
  }
  if (!cfg?.dmFallbackToChannel || !d.reminder.channelId) return null;
  const channel = await client.channels.fetch(d.reminder.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  return channel
    .send({
      components: [buildDeliveryContainer(d, { fallback: true })],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [userId] },
    })
    .then(() => "channel")
    .catch((e) => {
      console.log(`[REMINDER] 頻道備援提醒失敗 ${d.reminder._id}：${e?.message || e}`.yellow);
      return null;
    });
}

async function refreshGroupMessage(client, rem, state = "active") {
  if (!rem?.channelId || !rem?.messageId) return;
  const channel = await client.channels.fetch(rem.channelId).catch(() => null);
  const message = await channel?.messages?.fetch(rem.messageId).catch(() => null);
  if (!message) return;
  await message
    .edit({
      components: [buildGroupMessage(rem, state)],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] },
    })
    .catch((e) => console.log(`[REMINDER] 更新揪團訊息失敗 ${rem._id}：${e?.message || e}`.yellow));
}

// 揪團到點時在原頻道喊一聲，@ 所有參加者（Discord 單則最多 100 個 user mention）。
async function announceGroup(client, rem, occurrenceAt) {
  if (!cfg?.groupAnnounceInChannel || !rem.channelId || !rem.participants?.length) return;
  const channel = await client.channels.fetch(rem.channelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const ids = rem.participants.map((p) => p.userId).slice(0, 100);
  const container = new ContainerBuilder()
    .setAccentColor(cfg?.colors?.due ?? 0xe67e22)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🔔 揪團時間到：${rem.title}`))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `🕒 ${ts(occurrenceAt)}\n👥 ${ids.map((id) => `<@${id}>`).join(" ")}${
          rem.note ? `\n📝 ${rem.note}` : ""
        }`,
      ),
    );
  await channel
    .send({
      components: [container],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: ids },
      ...(rem.messageId ? { reply: { messageReference: rem.messageId, failIfNotExists: false } } : {}),
    })
    .catch((e) => console.log(`[REMINDER] 揪團到點播報失敗 ${rem._id}：${e?.message || e}`.yellow));
}

module.exports = { sendDelivery, refreshGroupMessage, announceGroup };
