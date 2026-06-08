const { MessageFlags } = require("discord.js");
const crypto = require("crypto");

const { MONEY_EMOJI } = require("../../constants/coin");
const { coinSystem, casino } = require("../../config");
const grantCoins = require("../../features/economy/grantCoins");
const {
  startGame,
  DEFAULT_HOUSE_EDGE,
} = require("../../features/casino/crash/engine");
const { buildPlayingPayload } = require("../../features/casino/crash/renderer");
const tickManager = require("../../features/casino/crash/tick");
const { saveLastBet } = require("../../features/casino/replay");
const logger = require("../../utils/logger");
const { trackError, trackSuccess } = require("../../utils/errorTracker");
const { consume } = require("../../utils/rateLimiter");

// 按下「確認發射」後先暫停這段時間，火箭停在 ×1.00 蓄勢，過了才真正升空。
const LAUNCH_DELAY_MS = 1_000;

function formatRemaining(sec) {
  const s = Math.max(0, Math.ceil(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分`;
}

async function replaceWithText(interaction, content) {
  await interaction.editReply({
    content,
    embeds: [],
    components: [],
    files: [],
    attachments: [],
  });
}

module.exports = async (client, interaction) => {
  try {
    if (!interaction.isButton()) return;
    const cid = interaction.customId || "";
    const isStart = cid.startsWith("cr_start_");
    const isCancel = cid.startsWith("cr_cancel_");
    if (!isStart && !isCancel) return;

    const parts = cid.split("_");
    const ownerId = parts[2];
    if (!ownerId) return;

    if (interaction.user.id !== ownerId) {
      try {
        await interaction.reply({
          content: "🚫 這不是你的火箭！別亂按 ㄎㄎ",
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    const rl = consume(interaction.user.id, "btn:crashStart", {
      windowMs: 1000,
      max: 1,
    });
    if (!rl.allowed) {
      try {
        await interaction.reply({
          content: `⏳ 點太快了，等 ${Math.ceil(rl.retryAfterMs / 1000)} 秒。`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_) { /* noop */ }
      return;
    }

    try {
      await interaction.deferUpdate();
    } catch (deferErr) {
      if (deferErr?.code === 10062) {
        logger.warn(
          { source: "crash-start", customId: cid },
          "互動已逾期，無法 defer",
        );
        trackError("crash-start", deferErr, { reason: "expired" });
        return;
      }
      throw deferErr;
    }

    if (isCancel) {
      await replaceWithText(interaction, "🚀 已取消發射，未扣款。");
      return;
    }

    // cr_start_<ownerId>_<bet>_<auto>
    const bet = Number(parts[3]);
    const autoArg = parts[4];
    if (!Number.isInteger(bet) || bet <= 0 || !autoArg) {
      await replaceWithText(interaction, "🔧 按鈕資料異常，請重新執行 /火箭。");
      return;
    }
    const autocashout = autoArg === "0" ? null : Number(autoArg);

    if (
      !coinSystem?.enabled ||
      !client.userCoinsCollection ||
      !client.coinTransactionsCollection ||
      !client.crashGamesCollection
    ) {
      await replaceWithText(interaction, "🔧 金幣系統尚未啟動！");
      return;
    }

    const cfg = casino?.crash || {};
    if (cfg.enabled === false) {
      await replaceWithText(interaction, "🔧 火箭暫時關閉中！");
      return;
    }

    const userId = interaction.user.id;
    const guildId = interaction.guildId;
    const username =
      interaction.member?.displayName || interaction.user.username;

    // 確認鍵被擱置一段時間後可能狀態已變，逐項重新檢查
    const existing = await client.crashGamesCollection.findOne({
      userId,
      guildId,
      status: "playing",
    });
    if (existing) {
      await replaceWithText(
        interaction,
        "🚀 你還有一支火箭在天上！等它落地（或爆炸）再開新局。",
      );
      return;
    }

    const cooldownSec = cfg.cooldownSeconds ?? 0;
    if (cooldownSec > 0) {
      const lastSettled = await client.crashGamesCollection.findOne(
        { userId, guildId, status: "settled" },
        { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } },
      );
      if (lastSettled?.updatedAt) {
        const lastAt = +lastSettled.updatedAt;
        const elapsedSec = (Date.now() - lastAt) / 1000;
        if (elapsedSec < cooldownSec) {
          const readyEpoch = Math.floor((lastAt + cooldownSec * 1000) / 1000);
          const remainSec = Math.ceil(cooldownSec - elapsedSec);
          await replaceWithText(
            interaction,
            `⏳ 火箭剛落地，還在補燃料！還要 **${formatRemaining(remainSec)}**，下次可發射：<t:${readyEpoch}:R>（<t:${readyEpoch}:t>）`,
          );
          return;
        }
      }
    }

    const before = await client.userCoinsCollection.findOne({ userId, guildId });
    const balance = before?.totalCoins || 0;
    if (balance < bet) {
      await replaceWithText(
        interaction,
        `${MONEY_EMOJI} 餘額不足！目前 **${balance.toLocaleString()}** credits，無法下注 ${bet.toLocaleString()}。`,
      );
      return;
    }

    const houseEdge = cfg.houseEdge ?? DEFAULT_HOUSE_EDGE;
    const gameId = crypto.randomUUID();

    const betResult = await grantCoins(client, {
      userId,
      guildId,
      username,
      avatarHash: interaction.user.avatar,
      amount: -bet,
      source: "bet",
      member: interaction.member,
      meta: { game: "crash", gameId },
    });
    if (!betResult) {
      await replaceWithText(interaction, "🔧 下注失敗，請稍後再試。");
      return;
    }
    const balanceAfter = betResult.doc?.totalCoins ?? balance - bet;

    const initial = startGame({
      bet,
      autocashout,
      houseEdge,
      now: Date.now() + LAUNCH_DELAY_MS,
    });
    const now = new Date();
    const ttlSec = cfg.gameTtlSeconds ?? 300;
    const messageId = interaction.message?.id;
    const doc = {
      ...initial,
      gameId,
      userId,
      guildId,
      username,
      channelId: interaction.channelId,
      messageId,
      startedAt: new Date(initial.startedAt),
      bustAt: new Date(initial.bustAt),
      autocashoutAt:
        initial.autocashoutAt != null ? new Date(initial.autocashoutAt) : null,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + ttlSec * 1000),
    };

    await client.crashGamesCollection.insertOne(doc);

    await saveLastBet(client, {
      userId,
      guildId,
      game: "crash",
      payload: {
        options: { 下注: String(bet), 自動收手: autocashout },
      },
    });

    const payload = buildPlayingPayload(
      { ...initial, gameId },
      {
        username,
        balance: balanceAfter,
        userId,
        avatarURL: interaction.user.displayAvatarURL(),
      },
    );
    await interaction.editReply(payload);

    const liveDoc = await client.crashGamesCollection.findOne({ gameId });
    if (liveDoc && liveDoc.status === "playing") {
      tickManager.start(client, liveDoc);
    }

    trackSuccess("crash-start");
  } catch (error) {
    logger.error(
      {
        source: "crash-start",
        userId: interaction.user?.id,
        customId: interaction.customId,
        err: error.message,
        stack: error.stack,
      },
      "火箭確認按鈕處理失敗",
    );
    trackError("crash-start", error, {
      userId: interaction.user?.id,
      customId: interaction.customId,
    });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "🔧 發射失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "🔧 發射失敗，請呼叫舒舒！",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (_) {
      /* noop */
    }
  }
};
