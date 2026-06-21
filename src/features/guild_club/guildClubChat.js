require("colors");
const { ChannelType } = require("discord.js");
const { guildClub } = require("../../config");

// 公會聊天串：每個公會自動建立一條 Private Thread 當內部聊天室。
// 加入 / 退會 / 解散都會自動同步 thread members 與發送提示訊息。
//
// thread.invitable: false → 成員無法自行拉外人，必須走幹部審核流程，bot 才會加人。
//
// 所有操作對主流程非阻擋（呼叫端用 .catch(() => {}) 包），建串失敗只記 log。

const cfg = () => guildClub?.chatThread || {};

const isEnabled = () => !!cfg().enabled;

const parentChannelId = () => cfg().parentChannelId || null;

const autoArchiveDuration = () => cfg().autoArchiveDuration || 1440;

const threadName = (clubName) => `🏛️ ${clubName}`;

async function fetchExistingThread(client, club) {
  if (!club?.chat_thread_id) return null;
  const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
  if (!thread) return null;
  if (thread.archived) {
    const ok = await thread.setArchived(false).catch(() => null);
    if (!ok) return null;
  }
  return thread;
}

async function createThread(client, club) {
  const parentId = parentChannelId();
  if (!parentId) return null;
  const parent = await client.channels.fetch(parentId).catch(() => null);
  if (!parent) return null;

  const thread = await parent.threads
    .create({
      name: threadName(club.name),
      type: ChannelType.PrivateThread,
      autoArchiveDuration: autoArchiveDuration(),
      invitable: false,
      reason: `公會聊天串：${club.name}`,
    })
    .catch((e) => {
      console.log(`[GUILD_CHAT] 建串失敗（${club.name}）：${e.message}`.yellow);
      return null;
    });
  if (!thread) return null;

  await client.guildsClubCollection
    .updateOne(
      { guild_club_id: club.guild_club_id },
      {
        $set: {
          chat_thread_id: thread.id,
          chat_thread_created_at: new Date(),
        },
      }
    )
    .catch(() => {});

  await thread
    .send({
      content:
        `📌 **${club.name}** 公會聊天室\n` +
        `等級 Lv.${club.level || 1}・最大成員 ${club.max_members || "?"}\n` +
        `-# 自己人聊天的地方，有事可以直接 @ 會長`,
    })
    .then((m) => m.pin().catch(() => {}))
    .catch(() => {});

  return thread;
}

async function ensureThread(client, club) {
  if (!isEnabled()) return null;
  if (!club) return null;
  const existing = await fetchExistingThread(client, club);
  if (existing) return existing;
  return createThread(client, club);
}

const WELCOME_BY_SOURCE = {
  create: (uid) => `🎉 公會創立！歡迎會長 <@${uid}> 開拓新天地`,
  invite: (uid) =>
    `🎊 <@${uid}> 接受邀請加入公會！這裡是大家聊天的地方，有任何問題都可以提出來～`,
  apply: (uid) =>
    `✅ <@${uid}> 通過申請加入公會！這裡是大家聊天的地方，有任何問題都可以提出來～`,
};

async function addMemberWithWelcome(client, { club, userId, source }) {
  if (!isEnabled()) return;
  const thread = await ensureThread(client, club);
  if (!thread) return;

  await thread.members.add(userId).catch((e) => {
    console.log(`[GUILD_CHAT] 加成員失敗（${userId}）：${e.message}`.yellow);
  });

  const buildMsg = WELCOME_BY_SOURCE[source] || ((uid) => `👋 <@${uid}> 加入公會！`);
  await thread
    .send({
      content: buildMsg(userId),
      allowedMentions: { users: [userId] },
    })
    .catch((e) => {
      console.log(`[GUILD_CHAT] 歡迎訊息失敗：${e.message}`.yellow);
    });
}

async function removeMember(client, { club, userId, reason }) {
  if (!isEnabled()) return;
  if (!club?.chat_thread_id) return;
  const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
  if (!thread) return;

  const text =
    reason === "kick"
      ? `👢 <@${userId}> 已被移出公會`
      : `🚪 <@${userId}> 離開了公會`;
  await thread
    .send({ content: text, allowedMentions: { users: [] } })
    .catch(() => {});

  await thread.members.remove(userId).catch(() => {});
}

async function archiveOnDisband(client, club, extraNote) {
  if (!isEnabled()) return;
  if (!club?.chat_thread_id) return;
  const thread = await client.channels.fetch(club.chat_thread_id).catch(() => null);
  if (!thread) return;

  await thread
    .send({
      content:
        `🔒 公會 **${club.name}** 已解散` +
        (extraNote ? `（${extraNote}）` : "") +
        `，本聊天室將被封存。`,
    })
    .catch(() => {});
  await thread.setLocked(true).catch(() => {});
  await thread.setArchived(true).catch(() => {});
}

module.exports = {
  isEnabled,
  ensureThread,
  addMemberWithWelcome,
  removeMember,
  archiveOnDisband,
};
