require("colors");

const { fetchStreamsByLogin, fetchUsersByLogin } = require("./api");
const { buildLiveStreamMessage } = require("./embed");
const {
  ensureIndexes,
  getLastStreamId,
  setLastStreamId,
} = require("./dedupe");

// In-memory fallback：沒有 mongo 時也能避免每次輪詢都重發
const memoryState = new Map();

const getMemoryStreamId = (login) => memoryState.get(login.toLowerCase()) || null;
const setMemoryStreamId = (login, streamId) =>
  memoryState.set(login.toLowerCase(), streamId);

const buildMessageContent = (template, displayName, mention) => {
  const base = (template || "")
    .replaceAll("{streamer}", displayName)
    .replaceAll("{name}", displayName)
    .trim();
  return [mention, base].filter(Boolean).join(" ");
};

/**
 * 跑一次 Twitch 開台檢查。
 *
 * @param {object} opts
 * @param {import("discord.js").Client} opts.client
 * @param {string} opts.channelId
 * @param {object} opts.config
 * @param {boolean} [opts.dryRun]
 */
const runTwitchLiveJob = async ({ client, channelId, config, dryRun = false }) => {
  const stats = { checked: 0, live: 0, pushed: 0, errors: 0 };

  const streamers = Array.isArray(config.streamers) ? config.streamers : [];
  if (streamers.length === 0) {
    return stats;
  }
  stats.checked = streamers.length;

  const channel = dryRun ? null : client.channels.cache.get(channelId);
  if (!dryRun && !channel) {
    console.log(`[ERROR] Twitch 通知：找不到頻道 ${channelId}`.red);
    return stats;
  }

  let streams;
  let users;
  try {
    [streams, users] = await Promise.all([
      fetchStreamsByLogin(streamers),
      fetchUsersByLogin(streamers),
    ]);
  } catch (error) {
    console.log(`[ERROR] Twitch API 失敗: ${error.message}`.red);
    stats.errors += 1;
    return stats;
  }

  const userByLogin = new Map();
  for (const u of users) userByLogin.set(u.login.toLowerCase(), u);

  const liveLogins = new Set();
  for (const stream of streams) {
    if (stream?.type !== "live") continue;
    const login = (stream.user_login || "").toLowerCase();
    if (!login) continue;
    liveLogins.add(login);
    stats.live += 1;

    const collection = client.twitchLiveStateCollection;
    const lastId = collection
      ? await getLastStreamId(collection, login)
      : getMemoryStreamId(login);

    if (lastId === stream.id) {
      // 同一場已經通知過了，跳過
      continue;
    }

    const user = userByLogin.get(login) || { login, display_name: stream.user_name };

    const mention = config.mentionEveryone
      ? "@everyone"
      : config.mentionRoleId
      ? `<@&${config.mentionRoleId}>`
      : "";
    const content = buildMessageContent(
      config.messageContent,
      user.display_name || login,
      mention
    );
    const { embed, row } = buildLiveStreamMessage({ stream, user });

    if (dryRun) {
      console.log(
        `[DRY-RUN] would push live notification for ${login} streamId=${stream.id}`.yellow
      );
      stats.pushed += 1;
      continue;
    }

    try {
      await channel.send({
        content: content || undefined,
        embeds: [embed],
        components: [row],
        allowedMentions: {
          parse: config.mentionEveryone ? ["everyone", "roles"] : ["roles"],
        },
      });
      if (collection) {
        await setLastStreamId(collection, login, stream.id, {
          startedAt: stream.started_at ? new Date(stream.started_at) : new Date(),
          gameName: stream.game_name || null,
          title: stream.title || null,
        });
      } else {
        setMemoryStreamId(login, stream.id);
      }
      stats.pushed += 1;
    } catch (error) {
      stats.errors += 1;
      console.log(
        `[ERROR] Twitch 通知推播失敗 (${login}): ${error.message}`.red
      );
    }
  }

  return stats;
};

module.exports = { runTwitchLiveJob, ensureIndexes };
