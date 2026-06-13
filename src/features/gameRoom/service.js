require("colors");

const {
  ChannelType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { gameRoom } = require("../../config");

const CLOSE_PREFIX = "gameroom_close_";

// 每個 slash command 進來都要判斷「是不是遊戲房」，必須走記憶體不打 DB。
// ready 時 primeCache 載入，開房 / 關房 / thread 事件同步維護。
const openRooms = new Map();

function isGameRoom(threadId) {
  return openRooms.has(threadId);
}

function getRoom(threadId) {
  return openRooms.get(threadId);
}

async function primeCache(client) {
  if (!client.gameRoomsCollection) return;
  const rooms = await client.gameRoomsCollection
    .find({ status: "open" })
    .project({ threadId: 1, ownerId: 1, guildId: 1, parentChannelId: 1, name: 1 })
    .toArray();
  openRooms.clear();
  for (const r of rooms) {
    openRooms.set(r.threadId, {
      ownerId: r.ownerId,
      guildId: r.guildId,
      parentChannelId: r.parentChannelId,
      name: r.name,
    });
  }
  if (rooms.length) {
    console.log(`[GAMEROOM] 載入 ${rooms.length} 間開啟中的遊戲房`.cyan);
  }
}

async function nextRoomSeq(client, guildId) {
  const doc = await client.countersCollection.findOneAndUpdate(
    { _id: `gameRoom:${guildId}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return doc.seq;
}

function roomName(seq, displayName) {
  return `${gameRoom.namePrefix}#${String(seq).padStart(3, "0")} - ${displayName}`.slice(0, 100);
}

function buildWelcomeContainer(room) {
  const visibilityNote =
    room.visibility === "private"
      ? "這是私人房，看不到房間的人由房主 @提及 即可拉進來。"
      : "這是公開房，任何人都可以加入一起玩。";

  return new ContainerBuilder()
    .setAccentColor(0x57f287)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# 🎮 ${room.name}\n房主：<@${room.ownerId}>\n${visibilityNote}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "這間房內可以使用**所有遊戲指令**（管理指令除外），不受頻道分流限制。"
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${CLOSE_PREFIX}${room.ownerId}`)
          .setLabel("關閉遊戲房")
          .setEmoji("🚪")
          .setStyle(ButtonStyle.Danger)
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# 此訊息已釘選，隨時可從右上角釘選圖示找到關房按鈕；也可以用 /關房 指令。24 小時沒有動靜會自動封存。"
      )
    );
}

async function createRoom(client, interaction, visibility) {
  const guildId = interaction.guildId;
  const ownerId = interaction.user.id;
  const displayName =
    interaction.member?.displayName || interaction.user.username;

  if (interaction.channel.type !== ChannelType.GuildText) {
    return { error: "not_text_channel" };
  }

  const existing = await client.gameRoomsCollection.findOne({
    guildId,
    ownerId,
    status: "open",
  });
  if (existing) return { error: "already_open", existing };

  const seq = await nextRoomSeq(client, guildId);
  const name = roomName(seq, displayName);

  let thread;
  try {
    thread = await interaction.channel.threads.create({
      name,
      type:
        visibility === "private"
          ? ChannelType.PrivateThread
          : ChannelType.PublicThread,
      autoArchiveDuration: gameRoom.autoArchiveDuration,
      reason: `遊戲房 by ${displayName}`,
    });
  } catch (e) {
    return { error: "thread_create_failed", detail: e.message };
  }

  await thread.members.add(ownerId).catch(() => {});

  const now = new Date();
  const room = {
    threadId: thread.id,
    guildId,
    parentChannelId: interaction.channelId,
    ownerId,
    ownerName: displayName,
    seq,
    name,
    visibility,
    status: "open",
    createdAt: now,
  };
  await client.gameRoomsCollection.insertOne(room);
  openRooms.set(thread.id, {
    ownerId,
    guildId,
    parentChannelId: interaction.channelId,
    name,
  });

  try {
    const welcome = await thread.send({
      components: [buildWelcomeContainer(room)],
      flags: MessageFlags.IsComponentsV2,
    });
    await welcome.pin().catch(() => {});
  } catch (e) {
    console.log(`[GAMEROOM] 歡迎訊息發送失敗：${e.message}`.yellow);
  }

  return { room, thread };
}

// 只負責 DB 狀態 + 封存討論串；給使用者的回覆由呼叫端在這之前處理，
// 避免討論串先被鎖住導致訊息發不出去。
async function closeRoom(client, threadId, { closedBy, reason } = {}) {
  openRooms.delete(threadId);
  await client.gameRoomsCollection.updateOne(
    { threadId, status: "open" },
    { $set: { status: "closed", closedAt: new Date(), closedBy, closeReason: reason } }
  );

  if (reason === "thread_deleted") return;
  try {
    const thread = await client.channels.fetch(threadId);
    if (thread?.isThread() && !thread.archived) {
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true);
    }
  } catch (_) {
    /* thread 已不存在就略過 */
  }
}

async function findOpenRoomByOwner(client, guildId, ownerId) {
  return client.gameRoomsCollection.findOne({ guildId, ownerId, status: "open" });
}

module.exports = {
  CLOSE_PREFIX,
  isGameRoom,
  getRoom,
  primeCache,
  createRoom,
  closeRoom,
  findOpenRoomByOwner,
};
