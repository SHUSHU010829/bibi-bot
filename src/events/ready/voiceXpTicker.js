require("colors");
const cron = require("node-cron");
const { levelSystem, coinSystem, questSystem } = require("../../config");
const { isVoiceXpEligible } = require("../../utils/xpGuards");
const grantXp = require("../../features/leveling/grantXp");
const grantCoins = require("../../features/economy/grantCoins");
const voiceSessionStore = require("../../utils/voiceSessionStore");
const questService = require("../../features/quests/questService");
const notifyQuestClaim = require("../../features/quests/notifyQuestClaim");

module.exports = async (client) => {
  if (!levelSystem?.enabled) return;
  if (!client.voiceXpSessions) client.voiceXpSessions = new Map();

  const cfg = levelSystem.voice;

  // 1) 把 DB 裡已存在的 session 載回 in-memory cache（重啟前的紀錄）
  try {
    const dbSessions = await voiceSessionStore.findAll(client);
    for (const s of dbSessions) {
      const key = voiceSessionStore.key(s.userId, s.guildId);
      client.voiceXpSessions.set(key, {
        userId: s.userId,
        guildId: s.guildId,
        channelId: s.channelId,
        joinedAt: s.joinedAt || Date.now(),
        username: s.username,
      });
    }
    if (dbSessions.length > 0) {
      console.log(`[SYSTEM] voiceXpTicker 從 DB 還原 ${dbSessions.length} 筆 session`.gray);
    }
  } catch (e) {
    console.log(`[WARNING] voiceXpTicker 從 DB 還原失敗: ${e}`.yellow);
  }

  // 2) sweep 目前語音中的人（保留已有 session 的 joinedAt，新進來的才寫 now）
  try {
    const seen = new Set();
    for (const [, guild] of client.guilds.cache) {
      for (const [, channel] of guild.channels.cache) {
        if (!channel.isVoiceBased?.()) continue;
        for (const [, member] of channel.members) {
          if (member.user.bot) continue;
          const key = voiceSessionStore.key(member.id, guild.id);
          seen.add(key);
          const existing = client.voiceXpSessions.get(key);
          const joinedAt = existing?.joinedAt || Date.now();
          const session = {
            userId: member.id,
            guildId: guild.id,
            channelId: channel.id,
            joinedAt,
            username: member.user.username,
          };
          client.voiceXpSessions.set(key, session);
          voiceSessionStore.upsert(client, session).catch(() => {});
        }
      }
    }

    // 不在線上但 DB / cache 還有紀錄的人 → 已離開但 voiceStateUpdate 沒抓到，清掉
    for (const key of [...client.voiceXpSessions.keys()]) {
      if (!seen.has(key)) {
        const s = client.voiceXpSessions.get(key);
        client.voiceXpSessions.delete(key);
        if (s) {
          voiceSessionStore.remove(client, s.userId, s.guildId).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.log(`[WARNING] voiceXpTicker initial sweep: ${e}`.yellow);
  }

  cron.schedule(
    "* * * * *",
    async () => {
      if (!client.userLevelsCollection) return;
      if (client.voiceXpSessions.size === 0) return;

      // 先按 guild 分組，每個 guild 一次 fetch 全部 user，避免每個 session 各 round-trip 一次
      const sessionsByGuild = new Map();
      for (const [key, sessionCached] of client.voiceXpSessions) {
        let session = sessionCached;
        if (!session) {
          const [userId, guildId] = key.split("-");
          session = await voiceSessionStore.get(client, userId, guildId);
          if (!session) continue;
        }
        if (!sessionsByGuild.has(session.guildId)) {
          sessionsByGuild.set(session.guildId, []);
        }
        sessionsByGuild.get(session.guildId).push({ key, session });
      }

      for (const [guildId, guildSessions] of sessionsByGuild) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        const userIds = guildSessions.map((s) => s.session.userId);
        await guild.members
          .fetch({ user: userIds })
          .catch(() => null);
      }

      for (const [, guildSessions] of sessionsByGuild) {
        for (const { key, session } of guildSessions) {
        try {
          const guild = client.guilds.cache.get(session.guildId);
          if (!guild) continue;
          const member = guild.members.cache.get(session.userId);
          if (!member) continue;

          const currentChannelId =
            member.voice.channelId || session.channelId;
          const channel = guild.channels.cache.get(currentChannelId);
          if (!channel) continue;

          if (!isVoiceXpEligible(member, channel, cfg)) continue;

          await grantXp(client, {
            userId: session.userId,
            guildId: session.guildId,
            username: member.user.username || session.username,
            avatarHash: member.user.avatar,
            amount: cfg.xpPerMinute,
            source: "voice",
            counterField: "xpFromVoice",
            incrementVoiceMinutes: 1,
            meta: { channelId: currentChannelId },
            channel: null,
            member,
          });

          // 語音任務：每分鐘 +1 進度（incrementProgress 內部已 cap 在 target）
          if (questSystem?.enabled && client.questProgressCollection) {
            const claimCtx = {
              member,
              username: member.user.username || session.username,
            };
            const notifyCtx = { user: member.user, userId: session.userId, guildId: session.guildId };
            questService
              .incrementProgress(client, session.userId, session.guildId, "daily_voice_30", 1, claimCtx)
              .then((res) => {
                if (res?.autoClaimed) {
                  notifyQuestClaim(client, notifyCtx, res.autoClaimed).catch(() => {});
                }
              })
              .catch((e) => console.log(`[ERROR] quest voice_30: ${e}`.red));
            questService
              .incrementProgress(client, session.userId, session.guildId, "daily_voice_60", 1, claimCtx)
              .then((res) => {
                if (res?.autoClaimed) {
                  notifyQuestClaim(client, notifyCtx, res.autoClaimed).catch(() => {});
                }
              })
              .catch((e) => console.log(`[ERROR] quest voice_60: ${e}`.red));
          }

          // 語音金幣：每 N 分鐘給 1（由 minute-of-session 判斷）
          if (coinSystem?.enabled && client.userCoinsCollection) {
            const tickMinutes = coinSystem.voice?.tickMinutes ?? 2;
            const coinsPerTick = coinSystem.voice?.coinsPerTick ?? 1;
            const elapsedMin = Math.floor(
              (Date.now() - (session.joinedAt || Date.now())) / 60000
            );
            if (
              tickMinutes > 0 &&
              coinsPerTick > 0 &&
              elapsedMin > 0 &&
              elapsedMin % tickMinutes === 0
            ) {
              await grantCoins(client, {
                userId: session.userId,
                guildId: session.guildId,
                username: member.user.username || session.username,
                avatarHash: member.user.avatar,
                amount: coinsPerTick,
                source: "voice",
                meta: { channelId: currentChannelId },
                member,
              });
            }
          }
        } catch (error) {
          console.log(`[ERROR] voiceXp tick (${key}):\n${error}`.red);
        }
        }
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Taipei",
    }
  );

  console.log(`[SYSTEM] 語音 XP ticker 啟動`.green);

  // 提醒：levelSystem.enabled 為 true 但沒設任何升級公告 channel 時 warn 一次
  const ann = levelSystem.levelUpAnnouncement;
  if (ann?.enabled && !ann.channelId && !ann.fallbackChannelId) {
    console.log(
      `[WARNING] levelUpAnnouncement 沒有設 channelId / fallbackChannelId，語音/反應升級時會找不到公告頻道`.yellow
    );
  }
};
