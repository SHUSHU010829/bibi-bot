require("colors");
const { ChannelType } = require("discord.js");

const findThreadByName = async (channel, name) => {
  const active = await channel.threads.fetchActive().catch(() => null);
  const hit = active?.threads?.find((t) => t.name === name);
  if (hit) return { thread: hit, archived: false };

  const archived = await channel.threads
    .fetchArchived({ limit: 100 })
    .catch(() => null);
  const archivedHit = archived?.threads?.find((t) => t.name === name);
  if (archivedHit) return { thread: archivedHit, archived: true };

  return null;
};

const getOrCreateWeeklyThread = async (channel, win, opts = {}) => {
  if (!channel) return null;
  const name = win.label;
  const existing = await findThreadByName(channel, name);
  if (existing) {
    if (existing.archived) {
      await existing.thread.setArchived(false).catch(() => {});
    }
    return existing.thread;
  }
  try {
    const thread = await channel.threads.create({
      name,
      type: ChannelType.PublicThread,
      autoArchiveDuration: opts.autoArchiveMinutes || 10080,
      reason: opts.reason || "weekly schedule auto-thread",
    });
    console.log(`[WEEKLY] 建立討論串「${name}」(${thread.id})`.cyan);
    return thread;
  } catch (err) {
    console.log(
      `[ERROR] 建立周表討論串失敗 name=${name}: ${err.message}`.red,
    );
    return null;
  }
};

module.exports = { getOrCreateWeeklyThread, findThreadByName };
